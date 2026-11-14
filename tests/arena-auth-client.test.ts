import { describe, expect, it, vi } from 'vitest';
import { arenaLoginTarget, disconnectArena, parseArenaAuthStatus, readArenaAuthStatus, safeArenaReturnTo } from '../src/integrations/arenaAuth';
import type { ArenaAuthStatus } from '../src/integrations/arenaAuth';

const disconnected: ArenaAuthStatus = { configured: true, connected: false, state: 'disconnected', loginPath: '/api/viewer/v1/auth/login' };
const connected: ArenaAuthStatus = { ...disconnected, connected: true, state: 'connected', logoutPath: '/api/viewer/v1/auth/logout', user: { id: 'arena-user', displayName: 'Verified user' }, workspaceId: 'arena-workspace' };
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

describe('browser Arena sign-in boundary', () => {
  it('accepts only verified session identities and fixed viewer-owned auth routes', () => {
    expect(parseArenaAuthStatus(connected)).toEqual(connected);
    expect(parseArenaAuthStatus(disconnected)).toEqual(disconnected);
    for (const loginPath of ['https://issuer.example/authorize', '//outside.example/login', '/api/viewer/v1/auth/login?redirect=outside', '/\\outside.example', '/api/viewer/v1/auth/login#fragment']) {
      expect(() => parseArenaAuthStatus({ ...disconnected, loginPath }), loginPath).toThrow('unsupported sign-in route');
    }
    expect(() => parseArenaAuthStatus({ ...connected, user: undefined })).toThrow('verified');
    expect(() => parseArenaAuthStatus({ ...connected, workspaceId: undefined })).toThrow('verified');
    expect(() => parseArenaAuthStatus({ ...connected, logoutPath: '/elsewhere' })).toThrow('unsupported sign-in route');
    expect(() => parseArenaAuthStatus({ ...connected, configured: false })).toThrow('invalid sign-in status');
    expect(() => parseArenaAuthStatus({ ...connected, state: 'disconnected' })).toThrow('conflicting');
    expect(() => parseArenaAuthStatus({ configured: true, connected: false })).toThrow('sign-in route');
  });

  it('returns only session metadata and never propagates token fields', () => {
    const result = parseArenaAuthStatus({ ...connected, accessToken: 'never-return', refreshToken: 'never-return', user: { ...connected.user, secret: 'never-return' } });
    expect(result).toEqual(connected);
    expect(JSON.stringify(result)).not.toContain('never-return');
  });

  it('retains exact source context in the return path while dropping auth query data and fragments', () => {
    const current = '/review?mode=arena&workspaceId=w&itemId=child&revision=03&fileId=file&edition=7&sourceHash=hash&parentItemId=parent&parentRevision=04&baselineRevision=02&baselineConfigurationId=frozen&code=one-time&state=oauth&access_token=secret&deployment=ignored#token';
    const safe = safeArenaReturnTo(current);
    const target = new URL(arenaLoginTarget(disconnected, current), 'https://viewer.example');
    expect(target.origin).toBe('https://viewer.example');
    expect(target.pathname).toBe('/api/viewer/v1/auth/login');
    expect(target.searchParams.get('returnTo')).toBe(safe);
    const returned = new URL(safe, 'https://viewer.example');
    expect(returned.pathname).toBe('/review');
    expect(Object.fromEntries(returned.searchParams)).toEqual({ mode: 'arena', workspaceId: 'w', itemId: 'child', revision: '03', fileId: 'file', edition: '7', sourceHash: 'hash', parentItemId: 'parent', parentRevision: '04', baselineRevision: '02', baselineConfigurationId: 'frozen' });
    expect(returned.hash).toBe('');
  });

  it('rejects external and auth-route return targets rather than redirecting away from the viewer', () => {
    for (const value of ['https://outside.example/', '//outside.example/', '/\\outside.example/', '/%2foutside.example/', '/%5coutside.example/', '/%00bad', '/api/viewer/v1/auth/logout', '/review\n?mode=arena']) {
      expect(() => safeArenaReturnTo(value), value).toThrow();
    }
    expect(() => arenaLoginTarget({ configured: false, connected: false, state: 'unconfigured' }, '/?mode=arena')).toThrow('not ready');
    expect(() => arenaLoginTarget(connected, '/?mode=arena')).toThrow('not ready');
    expect(() => arenaLoginTarget({ ...disconnected, loginPath: '//outside.example/' } as unknown as ArenaAuthStatus, '/')).toThrow('not ready');
  });

  it('checks status through the same-origin server without credentials or endpoint URLs in the payload', async () => {
    const fetcher = vi.fn(async () => json(disconnected));
    expect(await readArenaAuthStatus(undefined, fetcher)).toEqual(disconnected);
    expect(fetcher).toHaveBeenCalledWith('/api/viewer/v1/auth/status', expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } }));
    const unavailable = await readArenaAuthStatus(undefined, async () => new Response(null, { status: 404 }));
    expect(unavailable).toMatchObject({ configured: false, connected: false, state: 'unconfigured' });
    expect(unavailable.loginPath).toBeUndefined();
  });

  it('disconnects only the server session with an explicit same-origin POST and confirms failure', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    await disconnectArena(connected, undefined, fetcher);
    expect(fetcher).toHaveBeenCalledWith('/api/viewer/v1/auth/logout', expect.objectContaining({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } }));
    await expect(disconnectArena(disconnected, undefined, fetcher)).rejects.toThrow('No connected Arena session');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(disconnectArena(connected, undefined, async () => new Response('private upstream detail', { status: 403 }))).rejects.toThrow('did not confirm');
  });
});

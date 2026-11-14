/**
 * Copy into your PRIVATE server deployment and complete with reviewed Arena configuration.
 * This checked-in example stays unconfigured and never requests Preview sources.
 * Do not put bearer tokens, shared service-account credentials, or browser-authored
 * user/workspace headers here. Import an actual server session/OAuth bridge instead.
 */
import { createArenaMcpProvider } from './mcp-provider.mjs';

export async function createProvider() {
  // Select explicitly. The supplied development setup uses:
  // const endpoint = 'https://mcp-dev.srv.aws.bom.com/sand26/mcp';
  // The separate /mcp example is NOT assumed equivalent. No production URL is known.
  const endpoint = undefined;

  // Import private, reviewed OAuth configuration here; leave unset in this source.
  // { redirectUri:'https://YOUR-VIEWER/api/viewer/v1/auth/callback',
  //   client:{mode:'manual',clientId,clientSecret,tokenEndpointAuthMethod},
  //   resolveIdentity, store, cookieKey,
  //   allowedOrigins:['https://mcp-dev.srv.aws.bom.com','https://oauth.sand.bom.com:8261'] }
  // The origins above were disclosed by sand26 public discovery; select explicitly
  // and verify the registered client's auth method against authorization metadata.
  // CIMD alternative: client:{mode:'cimd',clientId:'https://YOUR-VIEWER/client-metadata.json'}.
  // A custom CIMD URL must be reachable from the chosen Arena environment.
  const oauthOptions = undefined;
  const oauthAuth = oauthOptions
    ? (await import('./oauth/index.mjs')).createArenaOAuth({ ...oauthOptions, mcpEndpoint: endpoint })
    : undefined;
  const mcpProvider = createArenaMcpProvider({
    endpoint,
    resolveSession: oauthAuth?.resolveSession, // Or a separately trusted server session bridge.
    approvedReadTools: [],      // Exact vendor read-tool names, reviewed individually. No wildcard.
    bindings: {},              // Required: getSchema, resolveBom, listRevisions, listAttachments, readContent.
    // Optional binding: listSupplierItems. No write bindings are supported.
    // connectionKey: aStable32ByteServerSecret, // Required by production preflight.
    // approvedResourceUri: (uri, context) => anExplicitTenantResourcePolicy(uri, context),
    sourceConversion: false,
  });
  // OAuth routes can connect a user before operation mappings have been completed.
  // An assistant's own MCP login is not this application's runtime session.
  return Object.freeze({ ...mcpProvider, ...(oauthAuth ? { oauthAuth } : {}) });
}

// Before attempting user login, inspect configuration on the server:
// npm run preflight:arena -- --provider /absolute/private/provider.mjs --json
// Exit 0 means local configuration is complete, NOT that Arena or Chrome passed.
// This command imports trusted deployment code; keep construction free of probes.

/*
Trusted session result:
  { userId, arenaUserId, workspaceId, sessionId, expiresAt, displayName?, accessToken }
or:
  { ...same identity, expiresAt,
    getAccessToken: async () => ({ ...same identity, expiresAt, accessToken }) }
expiresAt is epoch milliseconds. The resolver verifies the real human's session,
Arena subject, workspace membership and delegated grant. Do not construct identity
from X-User/X-Workspace headers. Grant refresh must retain every bound identity field.
A stable 32+ byte connectionKey from a secret manager is needed across BFF replicas;
the default random process key deliberately invalidates view URLs on server restart.
resolveSession(request,{signal}) receives a cancellation signal. The optional OAuth
module handles its own /api/viewer/v1/auth/{status,login,callback,logout} routes. Login
uses discovered resource/authorization metadata, authorization code + PKCE S256,
state validation and server-side sessions. Register the viewer's actual callback URI;
do not copy the coding assistant's localhost callback. Tokens never enter the browser.
resolveIdentity must validate the real Arena subject and workspace from trusted data;
the viewer does not invent JWT claim names or trust an unverified decoded token.

Bindings receive (readApi, query, publicContext). They normalize the vendor's actual
responses into src/domain.ts. readApi exposes listTools(), callTool(name,args),
readResource(uri) with an explicit approval predicate, data(result),
collectPages(async cursor => ({items,nextCursor?,total?,complete?})),
contentUrl(exactSourceIdentity), and signal. MCP catalog pagination and business-data
pagination are separate: use collectPages for the latter and reject incomplete BOMs.
Do not guess tool names, silently choose the latest file, infer placements from quantity,
or give a binding direct browser-supplied URLs. Read-only MCP cannot save comments.

Normalized SupplierItem: {id,itemId,supplierId,supplierName,partNumber,name,attributes,
attachments?}. query.itemId and query.revision identify its exact owning item edition.
Optional BomSnapshot.modelSources:
  [{id:fileGuid,itemId,revision,edition,sourceHash,occurrenceIds:[...]}]
These are actual source attachments and occurrence identities, not synthetic STEP IDs.
Response objects must contain only normalized domain fields; keep all tenant-specific
fields in attributes. Accidental SDK envelopes and upstream URLs are rejected.
Tools with x-mcp-header input annotations are currently excluded until a verified
vendor header-mapping policy is implemented. Tool metadata never authorizes writes.

Protected delivery: readApi.contentUrl({fileId,itemId,revision,edition,sourceHash,kind,
contentHash?}). kind = pdf|docx|doc|step|mesh. SHA256 digests are 64 lowercase hex.
A mesh retains the original STEP sourceHash and requires its separate contentHash.
Bindings return only these same-origin URLs in document/model metadata. readContent
must re-resolve and authorize the exact item-file relationship for this user on every
request. Return {identity,bytes:Uint8Array,contentType,name?}; bytes are verified before
delivery. No browser token, upstream signed URL, arbitrary remote fetch or shared cache.
32 MiB per file by default (configurable server limit). DOC conversion and CAD mesh
conversion remain unsupported until mapped and verified; sourceConversion stays false.
*/

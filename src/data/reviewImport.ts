import type { ReviewDocument } from '../domain';
import type { LocalReviewStore, ReviewRecoveryToken } from './reviewStore';

export interface ReviewImportRequest {
  store: LocalReviewStore;
  expectedRevision: number;
  recoveryToken: ReviewRecoveryToken | null;
}

/** Only the newest import in the active workspace may write or update the UI. */
export class ReviewImportController {
  private generation = 0;
  cancel(): void { this.generation++; }

  async readAndImport(file: Pick<File, 'text'>, request: ReviewImportRequest, apply: (review: ReviewDocument) => void): Promise<ReviewDocument | null> {
    const generation = ++this.generation;
    // Capture before yielding. Mutable workspace/recovery refs cannot change the
    // identity, version, or original corrupt payload of an in-flight import.
    const { store, expectedRevision, recoveryToken } = request;
    try {
      const json = await file.text();
      if (generation !== this.generation) return null;
      const imported = recoveryToken ? store.recoverFromBackup(json, recoveryToken) : store.import(json, expectedRevision);
      // Store writes and application are synchronous after the cancellation
      // check, so a workspace change cannot interleave them.
      apply(imported);
      return imported;
    } catch (error) {
      if (generation !== this.generation) return null;
      throw error;
    }
  }
}

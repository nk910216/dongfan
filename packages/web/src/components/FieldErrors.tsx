import { errorMessage, fieldErrorMessage, zhTW } from '@dongfan/shared';
import { ApiFailure, NetworkFailure } from '../lib/api.js';

/**
 * Turns whatever a request threw into something a parent can read.
 *
 * Every branch resolves through the copy file, including the fallbacks: a
 * raw code on screen is a bug, and this build will certainly meet a code
 * that was added after it shipped (spec 5.2).
 */
export function describeFailure(failure: unknown): string {
  // A check the form made itself, already resolved through the copy file.
  if (typeof failure === 'string') return failure;
  // Not an error code: the server never answered, so there is none.
  if (failure instanceof NetworkFailure) return zhTW.error.offline;
  if (failure instanceof ApiFailure) {
    const first = failure.fields[0];
    // Field errors are the specific ones, so they come first: "the amount
    // must be between 0 and 500" beats "check the highlighted fields".
    return first ? fieldErrorMessage(first) : errorMessage(failure.code);
  }
  return zhTW.error.UNKNOWN;
}

export function ErrorLine({ failure }: { failure: unknown }): React.JSX.Element | null {
  if (failure === null || failure === undefined) return null;
  return (
    <p className="mb-4 text-sm text-red-300" data-testid="form-error">
      {describeFailure(failure)}
    </p>
  );
}

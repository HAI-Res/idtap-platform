import cloneDeep from 'lodash/cloneDeep';
import type { RuleProfileType } from '@shared/types';

/**
 * What `getRaagRule` resolves to: the ragas doc (`{ rules, updatedDate }`),
 * `null` when the server has no doc for that name, or `undefined` when the
 * request itself failed (network error, non-2xx).
 */
export type RaagRuleResponse =
  | { rules?: RuleProfileType; updatedDate?: string | number | Date }
  | null
  | undefined;

export type RaagLoadState = {
  /** Rules shown in the editor. */
  rules: RuleProfileType;
  /** Rules as stored in the DB; undefined for a raga with no saved rules. */
  loadedRules: RuleProfileType | undefined;
  /**
   * The load failed: we do not know what the DB holds for this name, so the
   * editor must not save (it would write whatever is on screen over it with
   * no overwrite warning).
   */
  loadFailed: boolean;
  savedMsg: string;
};

/**
 * Editor state after selecting a raga in RaagEditor. Pure so it is testable
 * without mounting the component.
 */
export const raagLoadState = (
  res: RaagRuleResponse,
  template: RuleProfileType,
): RaagLoadState => {
  if (res === undefined) {
    return {
      rules: cloneDeep(template),
      loadedRules: undefined,
      loadFailed: true,
      savedMsg: 'could not load the saved rules for this raga; ' +
        'saving is disabled until it loads (reselect it to retry)',
    };
  }
  if (res !== null && res.rules) {
    const date = new Date(res.updatedDate as string);
    return {
      rules: cloneDeep(res.rules),
      loadedRules: cloneDeep(res.rules),
      loadFailed: false,
      savedMsg: 'Saved: ' + date.toLocaleString(),
    };
  }
  return {
    rules: cloneDeep(template),
    loadedRules: undefined,
    loadFailed: false,
    savedMsg: 'unsaved',
  };
};

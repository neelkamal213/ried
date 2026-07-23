// Shared Flywheel stage metadata — used by dashboard.html (founder-facing
// stage work) and admin-dashboard.html (approving advancement requests).
// Keeping the stage order and labels in one place means the two pages can
// never drift out of sync.

export const WORK_STAGE_ORDER = ['problem-discovery', 'research-translation', 'enterprise-build', 'complete'];

export const STAGE_LABELS = {
  'problem-discovery': 'Problem Discovery',
  'research-translation': 'Research Translation',
  'enterprise-build': 'Enterprise Build',
  'complete': 'Flywheel Complete'
};

export const STAGE_ICONS = {
  'problem-discovery': 'fa-magnifying-glass',
  'research-translation': 'fa-flask',
  'enterprise-build': 'fa-rocket',
  'complete': 'fa-champagne-glasses'
};

export function getNextStage(stageKey) {
  const idx = WORK_STAGE_ORDER.indexOf(stageKey);
  if (idx === -1 || idx === WORK_STAGE_ORDER.length - 1) return 'complete';
  return WORK_STAGE_ORDER[idx + 1];
}

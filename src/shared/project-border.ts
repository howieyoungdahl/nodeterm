import { APPEARANCE_RULES_VERSION, type BorderAppearance, type ProjectLayoutRules } from './appearance'

/** Edit only the selected border. Other layout rules and future keys must survive clearing the
 * last appearance entry. Display-local accessibility preferences never enter this shared block. */
export function withProjectBorder(
  rules: ProjectLayoutRules | undefined,
  value: BorderAppearance | undefined
): ProjectLayoutRules | undefined {
  const next = { ...rules }
  const appearance = { ...rules?.appearance }
  if (value) {
    appearance.project = { ...value }
    next.version ??= APPEARANCE_RULES_VERSION
  } else {
    delete appearance.project
  }
  if (Object.keys(appearance).length) next.appearance = appearance
  else delete next.appearance
  return Object.keys(next).length ? next : undefined
}

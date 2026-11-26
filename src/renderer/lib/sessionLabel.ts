/** Remove the activity prefix and folder suffix used in agent window titles. */
export function normalizeSessionLabel(title: string): string {
  return title
    .replace(/^[\u2800-\u28ff✳✻✽✶·◐◓◑◒⏵●○]\uFE0F? +/u, '')
    .replace(/ \| [^\s/\\:|]+$/u, '')
}

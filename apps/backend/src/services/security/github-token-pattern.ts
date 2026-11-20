export const GITHUB_TOKEN_PATTERN =
  "gh[pousr]_[A-Za-z0-9]{30,}|ghs_[0-9]+_eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+|github_pat_[A-Za-z0-9_]{20,}";

export function githubTokenRegex(flags = ""): RegExp {
  return new RegExp(GITHUB_TOKEN_PATTERN, flags);
}

export function normalizeStartScopeAndOwnership(input, defaults) {
  return {
    scope: input.scope ?? defaults.scope,
    managedBy: input.managedBy ?? defaults.managedBy
  };
}

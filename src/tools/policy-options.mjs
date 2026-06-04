const SCOPE_PARAMETER_DESCRIPTIONS = {
  config: "Use 'temporary' for session-only or 'persistent' to write config.",
  simple: "Use 'temporary' or 'persistent'."
};

const MANAGED_BY_PARAMETER_DESCRIPTIONS = {
  ownership: "Ownership label: 'userOwned' or 'modelOwned'.",
  afterUpdate: "Ownership label after the update: 'userOwned' or 'modelOwned'."
};

const FORCE_PARAMETER_DESCRIPTIONS = {
  emitter: "Required only when transferring ownership of a protected emitter.",
  sessionInjector: "Required only when transferring ownership of a protected session injector."
};

function stringParameter(description) {
  return { type: "string", description };
}

function booleanParameter(description) {
  return { type: "boolean", description };
}

export function policyScopeParameter(variant = "config") {
  return stringParameter(SCOPE_PARAMETER_DESCRIPTIONS[variant]);
}

export function policyManagedByParameter(variant = "ownership") {
  return stringParameter(MANAGED_BY_PARAMETER_DESCRIPTIONS[variant]);
}

export function policyForceParameter(target) {
  return booleanParameter(FORCE_PARAMETER_DESCRIPTIONS[target]);
}

export function policyParameterProperties({
  scope = "config",
  managedBy = "ownership",
  force
} = {}) {
  const properties = {};

  if (scope) {
    properties.scope = policyScopeParameter(scope);
  }

  if (managedBy) {
    properties.managedBy = policyManagedByParameter(managedBy);
  }

  if (force) {
    properties.force = policyForceParameter(force);
  }

  return properties;
}

export function policyOptions(args, { managedBy = true } = {}) {
  const options = {
    scope: args.scope
  };

  if (managedBy) {
    options.managedBy = args.managedBy;
  }

  options.force = args.force === true;
  return options;
}

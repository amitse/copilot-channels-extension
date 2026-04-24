import { MANAGED_BY, SCOPE } from "../consts.mjs";
import { normalizeManagedBy, normalizeScope } from "../util/normalize.mjs";
import { compileRegex } from "../util/regex.mjs";

export function createClassifier(source = {}, fallbackManagedBy = MANAGED_BY.MODEL, fallbackScope = SCOPE.TEMPORARY) {
  const includePattern = source.includePattern ? String(source.includePattern) : null;
  const excludePattern = source.excludePattern ? String(source.excludePattern) : null;
  const notifyPattern = source.notifyPattern ? String(source.notifyPattern) : null;

  return {
    includePattern,
    includeRegex: compileRegex(includePattern, "includePattern"),
    excludePattern,
    excludeRegex: compileRegex(excludePattern, "excludePattern"),
    notifyPattern,
    notifyRegex: compileRegex(notifyPattern, "notifyPattern"),
    managedBy: normalizeManagedBy(source.managedBy, fallbackManagedBy),
    scope: normalizeScope(source.scope, fallbackScope)
  };
}

export function getClassifierInput(source = {}) {
  if (source.classifier && typeof source.classifier === "object") {
    return source.classifier;
  }

  return {
    includePattern: source.includePattern,
    excludePattern: source.excludePattern,
    notifyPattern: source.notifyPattern,
    managedBy: source.classifierManagedBy ?? source.managedBy,
    scope: source.scope
  };
}

export function formatClassifier(classifier) {
  const include = classifier.includePattern ?? "*";
  const exclude = classifier.excludePattern ?? "<none>";
  const notify = classifier.notifyPattern ?? "<none>";
  return `include=${JSON.stringify(include)} exclude=${JSON.stringify(exclude)} notify=${JSON.stringify(notify)} scope=${classifier.scope} managedBy=${classifier.managedBy}`;
}

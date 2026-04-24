export function compileRegex(pattern, label) {
  if (pattern === undefined || pattern === null || pattern === "") {
    return null;
  }

  try {
    return new RegExp(String(pattern), "i");
  } catch (error) {
    throw new Error(`Invalid ${label} regex '${pattern}': ${error.message}`);
  }
}

export function createShellEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => name !== "BASH_ENV" && name !== "ENV" && !name.startsWith("BASH_FUNC_"),
    ),
  );
}

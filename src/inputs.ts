export const inputNames = [
  'success_env_var_name',
  'cache_paths',
  'cache_key',
  'github_token',
] as const;

export type InputKey = (typeof inputNames)[number];

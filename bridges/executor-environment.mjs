// No OpenAI credential belongs to a DeepSeek executor. Other provider
// authentication stays with the existing harness.
export const openAIEnvName = name => /^(?:(?:.*_)?OPENAI_|CODEX_API_KEY$)/i.test(name);

export function executorEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !openAIEnvName(name)));
}

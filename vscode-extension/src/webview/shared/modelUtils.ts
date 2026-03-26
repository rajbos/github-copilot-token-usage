/**
 * Returns a human-friendly display name for a given model identifier.
 */
export function getModelDisplayName(model: string): string {
    const names: Record<string, string> = {
        'gpt-4': 'GPT-4',
        'gpt-4.1': 'GPT-4.1',
        'gpt-4o': 'GPT-4o',
        'gpt-4o-mini': 'GPT-4o Mini',
        'gpt-3.5-turbo': 'GPT-3.5 Turbo',
        'gpt-5': 'GPT-5',
        'gpt-5-codex': 'GPT-5 Codex (Preview)',
        'gpt-5-mini': 'GPT-5 Mini',
        'gpt-5.1': 'GPT-5.1',
        'gpt-5.1-codex': 'GPT-5.1 Codex',
        'gpt-5.1-codex-max': 'GPT-5.1 Codex Max',
        'gpt-5.1-codex-mini': 'GPT-5.1 Codex Mini (Preview)',
        'gpt-5.2': 'GPT-5.2',
        'gpt-5.2-codex': 'GPT-5.2 Codex',
        'claude-sonnet-3.5': 'Claude Sonnet 3.5',
        'claude-sonnet-3.7': 'Claude Sonnet 3.7',
        'claude-sonnet-4': 'Claude Sonnet 4',
        'claude-sonnet-4.5': 'Claude Sonnet 4.5',
        'claude-haiku': 'Claude Haiku',
        'claude-haiku-4.5': 'Claude Haiku 4.5',
        'claude-opus-4.1': 'Claude Opus 4.1',
        'claude-opus-4.5': 'Claude Opus 4.5',
        'gemini-2.5-pro': 'Gemini 2.5 Pro',
        'gemini-3-flash': 'Gemini 3 Flash',
        'gemini-3-pro': 'Gemini 3 Pro',
        'gemini-3-pro-preview': 'Gemini 3 Pro (Preview)',
        'grok-code-fast-1': 'Grok Code Fast 1',
        'raptor-mini': 'Raptor Mini',
        'o3-mini': 'o3-mini',
        'o4-mini': 'o4-mini (Preview)'
    };
    return names[model] || model;
}
// ============================================
// WACA - WhatsApp Client Tracker Agent - Multi-Provider LLM Layer
// Supports: Ollama, OpenAI, Anthropic, Grok (xAI)
// ============================================
//
// All providers use their native HTTP/REST APIs — no SDKs needed.
// Set LLM_PROVIDER in .env to switch between them.

require('dotenv').config();

const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'ollama').toLowerCase();

// ── Provider implementations ────────────────────────────

async function callOllama(prompt) {
    const url = process.env.OLLAMA_URL || 'http://localhost:11434';
    const model = process.env.OLLAMA_MODEL || 'llama3.2';

    const res = await fetch(`${url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            format: 'json',
            stream: false,
            options: { temperature: 0.3 },
        }),
    });

    if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.message.content.trim();
}

async function callOpenAI(prompt) {
    const url = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

    const res = await fetch(`${url}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.3,
            response_format: { type: 'json_object' },
        }),
    });

    if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.choices[0].message.content.trim();
}

async function callAnthropic(prompt) {
    const url = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

    const res = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model,
            max_tokens: 1024,
            messages: [{ role: 'user', content: prompt }],
        }),
    });

    if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.content[0].text.trim();
}

async function callGrok(prompt) {
    const url = process.env.GROK_BASE_URL || 'https://api.x.ai/v1';
    const model = process.env.GROK_MODEL || 'grok-3-mini';
    const apiKey = process.env.GROK_API_KEY;
    if (!apiKey) throw new Error('GROK_API_KEY is not set');

    // Grok/xAI uses the OpenAI-compatible API format
    const res = await fetch(`${url}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.3,
            response_format: { type: 'json_object' },
        }),
    });

    if (!res.ok) throw new Error(`Grok error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.choices[0].message.content.trim();
}

// ── Provider dispatch ───────────────────────────────────

const providers = {
    ollama: callOllama,
    openai: callOpenAI,
    anthropic: callAnthropic,
    grok: callGrok,
};

async function callLLM(prompt) {
    const fn = providers[LLM_PROVIDER];
    if (!fn) {
        throw new Error(
            `Unknown LLM_PROVIDER "${LLM_PROVIDER}". Must be one of: ${Object.keys(providers).join(', ')}`
        );
    }
    return fn(prompt);
}

function getProviderInfo() {
    const info = { provider: LLM_PROVIDER };
    switch (LLM_PROVIDER) {
        case 'ollama':
            info.model = process.env.OLLAMA_MODEL || 'llama3.2';
            info.url = process.env.OLLAMA_URL || 'http://localhost:11434';
            break;
        case 'openai':
            info.model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
            break;
        case 'anthropic':
            info.model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
            break;
        case 'grok':
            info.model = process.env.GROK_MODEL || 'grok-3-mini';
            break;
    }
    return info;
}

module.exports = { callLLM, getProviderInfo };

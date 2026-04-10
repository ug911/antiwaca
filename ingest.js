// ============================================
// WISE CLIENT TRACKER - WhatsApp Ingestion Service
// Runs on the dedicated laptop / small server
// ============================================
// 
// Setup:
//   npm install
//   Configure LLM_PROVIDER in .env (ollama, openai, anthropic, grok)
//
// First run: node ingest.js
//   -> Scan QR code with your WhatsApp to link the device
//   -> Subsequent runs auto-reconnect (session stored in ./auth_state)

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const { Pool } = require('pg');
const pino = require('pino');
const { callLLM, getProviderInfo } = require('./llm');
require('dotenv').config();

// ── Config ──────────────────────────────────────────────
const db = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'wise_tracker',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
});

const logger = pino({ level: 'info' });

// Phone numbers of known team members (won't be triaged as client messages)
const TEAM_PHONES = new Set([
    process.env.PHONE_UTKARSH,
    process.env.PHONE_MUBEEN,
    process.env.PHONE_RAHUL,
    process.env.PHONE_SANDHYA,
].filter(Boolean));

// ── Database helpers ────────────────────────────────────

// Register or update a WhatsApp source (DM or group). Returns { id, tracked, client_id }.
async function upsertWaSource(jid, sourceType, displayName, phone) {
    const result = await db.query(
        `INSERT INTO wa_sources (jid, source_type, display_name, phone, last_message_at, message_count)
         VALUES ($1, $2, $3, $4, NOW(), 1)
         ON CONFLICT (jid) DO UPDATE SET
            display_name = COALESCE(EXCLUDED.display_name, wa_sources.display_name),
            last_message_at = NOW(),
            message_count = wa_sources.message_count + 1,
            updated_at = NOW()
         RETURNING id, tracked, client_id`,
        [jid, sourceType, displayName, phone]
    );
    return result.rows[0];
}

async function getOrCreateClient(phone, pushName) {
    // Check if client exists
    let result = await db.query('SELECT id FROM clients WHERE phone = $1', [phone]);
    if (result.rows.length > 0) return result.rows[0].id;

    // Auto-create with basic info
    result = await db.query(
        `INSERT INTO clients (name, phone, status)
         VALUES ($1, $2, 'active')
         RETURNING id`,
        [pushName || phone, phone]
    );
    logger.info({ phone, pushName }, 'New client auto-created');
    return result.rows[0].id;
}

async function storeMessage(clientId, msg, direction, senderPhone, senderName, waSourceId) {
    const body = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || '[media]';

    const mediaType = msg.message?.imageMessage ? 'image'
        : msg.message?.videoMessage ? 'video'
        : msg.message?.documentMessage ? 'document'
        : msg.message?.audioMessage ? 'audio'
        : null;

    const result = await db.query(
        `INSERT INTO messages (client_id, wa_source_id, wa_message_id, direction, body, media_type, sender_phone, sender_name, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (wa_message_id) DO NOTHING
         RETURNING id`,
        [clientId, waSourceId, msg.key.id, direction, body, mediaType, senderPhone, senderName, new Date(msg.messageTimestamp * 1000)]
    );
    return result.rows[0]?.id;
}

async function getRecentMessages(clientId, limit = 10) {
    const result = await db.query(
        `SELECT body, direction, sender_name, timestamp
         FROM messages
         WHERE client_id = $1
         ORDER BY timestamp DESC
         LIMIT $2`,
        [clientId, limit]
    );
    return result.rows.reverse(); // chronological order
}

// ── LLM Triage ──────────────────────────────────────────
async function triageWithLLM(clientName, recentMessages) {
    const conversationLog = recentMessages.map(m =>
        `[${m.direction === 'inbound' ? clientName : 'Us'}] ${m.body}`
    ).join('\n');

    const prompt = `You are a support triage agent for Wise, an EdTech infrastructure platform that powers Zoom-based tutoring sessions.

Given this recent WhatsApp conversation with client "${clientName}", produce a JSON response with:
{
  "category": one of "feature_request" | "bug_report" | "urgent_issue" | "billing_question" | "general_query" | "onboarding_help",
  "priority": one of "critical" | "high" | "medium" | "low",
  "summary": "One-line summary of what the client needs",
  "context": "2-3 sentence summary of the recent situation/happenings with this client",
  "draft_response": "A short, professional WhatsApp reply we could send"
}

Rules:
- "critical" priority is ONLY for: production outages, sessions not working for students RIGHT NOW, billing errors causing service disruption
- "high" for: bugs affecting upcoming sessions, urgent deadline requests
- "medium" for: feature requests, non-blocking bugs, scheduling questions
- "low" for: general check-ins, FYIs, thank-you messages

Conversation:
${conversationLog}

Respond ONLY with the JSON object, no markdown fences.`;

    const text = await callLLM(prompt);
    return JSON.parse(text);
}

async function createTask(clientId, messageId, triage) {
    const result = await db.query(
        `INSERT INTO tasks (client_id, source_message_ids, category, priority, summary, context, draft_response, assigned_to)
         VALUES ($1, $2, $3, $4, $5, $6, $7,
                 (SELECT poc_id FROM clients WHERE id = $1))
         RETURNING id, priority`,
        [clientId, [messageId], triage.category, triage.priority, triage.summary, triage.context, triage.draft_response]
    );
    return result.rows[0];
}

// ── Urgent Alert System ─────────────────────────────────
// Uses a simple webhook approach — integrate with:
//   - Twilio API for actual phone calls
//   - Or a simple push notification service
//   - Or even send a WhatsApp message to the manager via the same socket
async function alertOnUrgent(sock, clientName, triage, clientId) {
    if (triage.priority !== 'critical') return;

    logger.warn({ clientName, summary: triage.summary }, '🚨 CRITICAL ISSUE - Alerting managers');

    // Option 1: Send WhatsApp alert to managers via the same connection
    const managers = await db.query(
        `SELECT tm.phone, tm.name FROM team_members tm WHERE tm.role = 'manager'`
    );

    for (const manager of managers.rows) {
        const alertMsg = `🚨 URGENT from ${clientName}\n\n${triage.summary}\n\nContext: ${triage.context}\n\nSuggested reply: ${triage.draft_response}`;

        await sock.sendMessage(`${manager.phone.replace('+', '')}@s.whatsapp.net`, {
            text: alertMsg
        });
        logger.info({ manager: manager.name }, 'Alert sent to manager');
    }

    // Option 2: Twilio call (uncomment and configure if needed)
    // const twilio = require('twilio')(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
    // for (const manager of managers.rows) {
    //     await twilio.calls.create({
    //         twiml: `<Response><Say>Urgent client issue from ${clientName}. ${triage.summary}. Please check the dashboard.</Say></Response>`,
    //         to: manager.phone,
    //         from: process.env.TWILIO_PHONE,
    //     });
    // }

    // Mark alert as sent
    await db.query(
        `UPDATE tasks SET alert_sent = true
         WHERE client_id = $1 AND status = 'open' AND priority = 'critical'
         AND alert_sent = false`,
        [clientId]
    );
}

// ── WhatsApp Connection ─────────────────────────────────
async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_state');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,        // Scan this on first run
    });

    // Handle connection events
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) {
                logger.info('Reconnecting...');
                startWhatsApp(); // auto-reconnect
            } else {
                logger.error('Logged out. Delete ./auth_state and re-scan QR.');
            }
        } else if (connection === 'open') {
            logger.info('✅ WhatsApp connected');
        }
    });

    // Save credentials on update
    sock.ev.on('creds.update', saveCreds);

    // ── Main message handler ────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
        if (type !== 'notify') return; // ignore history sync

        for (const msg of msgs) {
            try {
                if (msg.key.fromMe) continue; // skip our own messages
                if (!msg.message) continue;    // skip protocol messages

                const jid = msg.key.remoteJid;
                const isGroup = jid.endsWith('@g.us');
                const phone = isGroup ? null : jid.replace('@s.whatsapp.net', '');
                const pushName = msg.pushName || phone || jid;

                // For groups, try to fetch the group subject for display
                let displayName = pushName;
                if (isGroup) {
                    try {
                        const groupMeta = await sock.groupMetadata(jid);
                        displayName = groupMeta.subject || jid;
                    } catch { displayName = jid; }
                }

                // Register this source (DM or group) — always, even if not tracked
                const source = await upsertWaSource(
                    jid,
                    isGroup ? 'group' : 'dm',
                    displayName,
                    phone ? '+' + phone : null
                );

                // Only process messages from tracked sources
                if (!source.tracked) continue;

                // Use the client linked to this source
                const clientId = source.client_id;
                if (!clientId) {
                    logger.warn({ jid }, 'Source is tracked but has no linked client — skipping');
                    continue;
                }

                const senderPhone = isGroup
                    ? '+' + (msg.key.participant || '').replace('@s.whatsapp.net', '')
                    : '+' + phone;

                const messageId = await storeMessage(clientId, msg, 'inbound', senderPhone, pushName, source.id);

                if (!messageId) continue; // duplicate

                logger.info({ client: pushName, body: msg.message?.conversation?.slice(0, 50) }, 'New message');

                // Fetch recent context and triage
                const recent = await getRecentMessages(clientId);
                const triage = await triageWithLLM(pushName, recent);

                logger.info({ client: pushName, category: triage.category, priority: triage.priority }, 'Triaged');

                // Create task
                const task = await createTask(clientId, messageId, triage);

                // Alert if urgent
                await alertOnUrgent(sock, pushName, triage, clientId);

            } catch (err) {
                logger.error({ err, msgId: msg.key.id }, 'Error processing message');
            }
        }
    });

    return sock;
}

// ── Boot ─────────────────────────────────────────────────
const llmInfo = getProviderInfo();
logger.info({ provider: llmInfo.provider, model: llmInfo.model }, 'LLM provider configured');

startWhatsApp().catch(err => {
    logger.error({ err }, 'Fatal error');
    process.exit(1);
});

// ============================================
// WACA - WhatsApp Client Tracker Agent - Dashboard API Server
// Serves the dashboard UI + REST API for Postgres
// ============================================
//
// Setup:
//   npm install express pg cors dotenv
//   node server.js
//
// Runs on http://localhost:3000

const express = require('express');
const cors = require('cors');
const path = require('path');
const { db, getDbInfo } = require('./db');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
// Serve React frontend (built output)
app.use(express.static(path.join(__dirname, 'frontend', 'dist')));

// ── Dashboard Metrics ───────────────────────────────────
app.get('/api/metrics', async (req, res) => {
    try {
        const [clients, openTasks, urgentTasks, avgResponse] = await Promise.all([
            db.query(`SELECT COUNT(*) FROM clients WHERE status = 'active'`),
            db.query(`SELECT COUNT(*) FROM tasks WHERE status IN ('open', 'in_progress')`),
            db.query(`SELECT COUNT(*) FROM tasks WHERE status = 'open' AND priority = 'critical'`),
            db.query(`
                SELECT COALESCE(
                    ROUND(AVG(EXTRACT(EPOCH FROM (
                        (SELECT MIN(m2.timestamp) FROM messages m2
                         WHERE m2.client_id = m.client_id
                         AND m2.direction = 'outbound'
                         AND m2.timestamp > m.timestamp)
                        - m.timestamp
                    )) / 3600)::numeric, 1
                ), 0) as avg_hours
                FROM messages m
                WHERE m.direction = 'inbound'
                AND m.timestamp > NOW() - INTERVAL '7 days'
            `),
        ]);
        res.json({
            active_clients: parseInt(clients.rows[0].count),
            open_tasks: parseInt(openTasks.rows[0].count),
            urgent_issues: parseInt(urgentTasks.rows[0].count),
            avg_response_hours: parseFloat(avgResponse.rows[0].avg_hours),
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch metrics' });
    }
});

// ── Client Health Overview ──────────────────────────────
app.get('/api/clients', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT
                c.id, c.name, c.org_name, c.phone, c.status,
                tm.name AS poc_name,
                (SELECT MAX(m.timestamp) FROM messages m WHERE m.client_id = c.id AND m.direction = 'inbound') AS last_client_message_at,
                (SELECT MAX(m.timestamp) FROM messages m WHERE m.client_id = c.id AND m.direction = 'outbound') AS last_reply_at,
                (SELECT COUNT(*) FROM tasks t WHERE t.client_id = c.id AND t.status IN ('open', 'in_progress')) AS open_tasks
            FROM clients c
            LEFT JOIN team_members tm ON c.poc_id = tm.id
            ORDER BY last_client_message_at DESC NULLS LAST
        `);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch clients' });
    }
});

// ── Task Queue ──────────────────────────────────────────
app.get('/api/tasks', async (req, res) => {
    const { category, status, priority } = req.query;
    try {
        let query = `
            SELECT
                t.id, t.category, t.priority, t.summary, t.context,
                t.draft_response, t.status, t.alert_sent, t.created_at,
                c.name AS client_name, c.phone AS client_phone,
                tm.name AS assigned_to_name,
                (SELECT MAX(m.timestamp) FROM messages m WHERE m.client_id = t.client_id AND m.direction = 'inbound') AS last_msg_at
            FROM tasks t
            JOIN clients c ON t.client_id = c.id
            LEFT JOIN team_members tm ON t.assigned_to = tm.id
            WHERE 1=1
        `;
        const params = [];
        if (category && category !== 'all') {
            params.push(category);
            query += ` AND t.category = $${params.length}`;
        }
        if (status) {
            params.push(status);
            query += ` AND t.status = $${params.length}`;
        }
        if (priority) {
            params.push(priority);
            query += ` AND t.priority = $${params.length}`;
        }
        query += ` ORDER BY
            CASE t.priority
                WHEN 'critical' THEN 1
                WHEN 'high' THEN 2
                WHEN 'medium' THEN 3
                WHEN 'low' THEN 4
            END,
            t.created_at DESC`;

        const result = await db.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch tasks' });
    }
});

// ── Update Task Status ──────────────────────────────────
app.patch('/api/tasks/:id', async (req, res) => {
    const { id } = req.params;
    const { status, assigned_to } = req.body;
    try {
        const updates = [];
        const params = [];
        if (status) {
            params.push(status);
            updates.push(`status = $${params.length}`);
            if (status === 'resolved') {
                updates.push(`resolved_at = NOW()`);
            }
        }
        if (assigned_to) {
            params.push(assigned_to);
            updates.push(`assigned_to = $${params.length}`);
        }
        updates.push('updated_at = NOW()');
        params.push(id);
        const result = await db.query(
            `UPDATE tasks SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
            params
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update task' });
    }
});

// ── Conversation History for a Client ───────────────────
app.get('/api/clients/:id/messages', async (req, res) => {
    const { id } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    try {
        const result = await db.query(
            `SELECT id, direction, body, sender_name, media_type, timestamp
             FROM messages
             WHERE client_id = $1
             ORDER BY timestamp DESC
             LIMIT $2`,
            [id, limit]
        );
        res.json(result.rows.reverse());
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

// ── WhatsApp Sources (Super Admin) ─────────────────────
// List all discovered sources with tracking status
app.get('/api/sources', async (req, res) => {
    const { tracked, source_type } = req.query;
    try {
        let query = `
            SELECT ws.*, c.name AS client_name
            FROM wa_sources ws
            LEFT JOIN clients c ON ws.client_id = c.id
            WHERE 1=1
        `;
        const params = [];
        if (tracked !== undefined) {
            params.push(tracked === 'true');
            query += ` AND ws.tracked = $${params.length}`;
        }
        if (source_type) {
            params.push(source_type);
            query += ` AND ws.source_type = $${params.length}`;
        }
        query += ` ORDER BY ws.last_message_at DESC NULLS LAST`;
        const result = await db.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch sources' });
    }
});

// Track/untrack a source and link it to a client
app.patch('/api/sources/:id', async (req, res) => {
    const { id } = req.params;
    const { tracked, client_id } = req.body;
    try {
        const updates = [];
        const params = [];

        if (tracked !== undefined) {
            params.push(tracked);
            updates.push(`tracked = $${params.length}`);
        }
        if (client_id !== undefined) {
            params.push(client_id);
            updates.push(`client_id = $${params.length}`);
        }
        updates.push('updated_at = NOW()');
        params.push(id);

        const result = await db.query(
            `UPDATE wa_sources SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
            params
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update source' });
    }
});

// Track a source + auto-create a client for it in one step
app.post('/api/sources/:id/track', async (req, res) => {
    const { id } = req.params;
    const { client_name, org_name } = req.body;
    try {
        const source = await db.query('SELECT * FROM wa_sources WHERE id = $1', [id]);
        if (!source.rows.length) return res.status(404).json({ error: 'Source not found' });

        const ws = source.rows[0];
        let clientId = ws.client_id;
        if (!clientId) {
            const clientResult = await db.query(
                `INSERT INTO clients (name, org_name, phone, status)
                 VALUES ($1, $2, $3, 'active')
                 RETURNING id`,
                [client_name || ws.display_name, org_name || null, ws.phone || ws.jid]
            );
            clientId = clientResult.rows[0].id;
        }

        const result = await db.query(
            `UPDATE wa_sources SET tracked = true, client_id = $1, updated_at = NOW()
             WHERE id = $2 RETURNING *`,
            [clientId, id]
        );

        res.json({ source: result.rows[0], client_id: clientId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to track source' });
    }
});

// Link a source to an existing client (for merging multiple sources into one client)
app.post('/api/sources/:id/link', async (req, res) => {
    const { id } = req.params;
    const { client_id } = req.body;
    try {
        const result = await db.query(
            `UPDATE wa_sources SET tracked = true, client_id = $1, updated_at = NOW()
             WHERE id = $2 RETURNING *`,
            [client_id, id]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'Source not found' });

        // Re-assign existing messages from this source to the new client
        await db.query(
            `UPDATE messages SET client_id = $1 WHERE wa_source_id = $2`,
            [client_id, id]
        );

        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to link source' });
    }
});

// Merge two clients: move all data from source client into target client
app.post('/api/clients/merge', async (req, res) => {
    const { source_client_id, target_client_id } = req.body;
    try {
        await db.query('BEGIN');
        await db.query('UPDATE wa_sources SET client_id = $1 WHERE client_id = $2', [target_client_id, source_client_id]);
        await db.query('UPDATE messages SET client_id = $1 WHERE client_id = $2', [target_client_id, source_client_id]);
        await db.query('UPDATE tasks SET client_id = $1 WHERE client_id = $2', [target_client_id, source_client_id]);
        await db.query(
            `UPDATE clients SET status = 'inactive',
             notes = CONCAT(COALESCE(notes, ''), ' [Merged into client #' || $1 || ']')
             WHERE id = $2`,
            [target_client_id, source_client_id]
        );
        await db.query('COMMIT');
        res.json({ merged: true, target_client_id });
    } catch (err) {
        await db.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Failed to merge clients' });
    }
});

// Get all sources linked to a client
app.get('/api/clients/:id/sources', async (req, res) => {
    try {
        const result = await db.query(
            'SELECT * FROM wa_sources WHERE client_id = $1 ORDER BY last_message_at DESC',
            [req.params.id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch client sources' });
    }
});

// ── Team Members ────────────────────────────────────────
app.get('/api/team', async (req, res) => {
    try {
        const result = await db.query('SELECT id, name, role FROM team_members ORDER BY role, name');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch team' });
    }
});

// SPA fallback — serve index.html for any non-API route
app.get('/{*splat}', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(__dirname, 'frontend', 'dist', 'index.html'));
});

// ── Boot ─────────────────────────────────────────────────
const PORT = process.env.DASHBOARD_PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Dashboard API running on http://localhost:${PORT}`);
    console.log(`   Database: ${getDbInfo()}`);
    console.log(`   GET  /api/metrics         - Dashboard summary`);
    console.log(`   GET  /api/clients          - Client health list`);
    console.log(`   GET  /api/tasks            - Task queue (filter: ?category=&status=&priority=)`);
    console.log(`   PATCH /api/tasks/:id       - Update task status`);
    console.log(`   GET  /api/clients/:id/messages - Client conversation`);
    console.log(`   GET  /api/team             - Team members`);
});

-- ============================================
-- WACA - WhatsApp Client Tracker Agent - Database Schema
-- ============================================

-- Team members who manage client relationships
CREATE TABLE team_members (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('poc', 'manager', 'super_admin')),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Seed team
INSERT INTO team_members (name, phone, role) VALUES
    ('Rahul', '+91XXXXXXXXXX', 'poc'),
    ('Sandhya', '+91XXXXXXXXXX', 'poc'),
    ('Utkarsh', '+91XXXXXXXXXX', 'super_admin'),
    ('Mubeen', '+91XXXXXXXXXX', 'manager');

-- Clients (each WhatsApp contact/org)
CREATE TABLE clients (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    org_name VARCHAR(200),
    phone VARCHAR(20) NOT NULL UNIQUE,
    poc_id INTEGER REFERENCES team_members(id),
    external_account_id VARCHAR(100),    -- link to external platform if applicable
    status VARCHAR(30) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'onboarding', 'churned')),
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- WhatsApp sources (every DM/group seen by the system)
-- Utkarsh reviews these and marks which ones to track
CREATE TABLE wa_sources (
    id SERIAL PRIMARY KEY,
    jid VARCHAR(100) NOT NULL UNIQUE,         -- WhatsApp JID (phone@s.whatsapp.net or groupid@g.us)
    source_type VARCHAR(10) NOT NULL CHECK (source_type IN ('dm', 'group')),
    display_name VARCHAR(200),                -- push name or group subject
    phone VARCHAR(20),                        -- phone number for DMs (null for groups)
    tracked BOOLEAN DEFAULT FALSE,            -- whether to process messages from this source
    client_id INTEGER REFERENCES clients(id), -- linked client (set when tracked)
    last_message_at TIMESTAMP,
    message_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_wa_sources_jid ON wa_sources(jid);
CREATE INDEX idx_wa_sources_tracked ON wa_sources(tracked);
CREATE INDEX idx_wa_sources_client_id ON wa_sources(client_id);

-- Raw WhatsApp messages
CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    client_id INTEGER REFERENCES clients(id),
    wa_source_id INTEGER REFERENCES wa_sources(id),
    wa_message_id VARCHAR(100) UNIQUE,  -- WhatsApp's own message ID for dedup
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    body TEXT,
    media_type VARCHAR(30),             -- image, video, document, audio, null
    media_url TEXT,
    sender_phone VARCHAR(20) NOT NULL,
    sender_name VARCHAR(200),
    is_group BOOLEAN DEFAULT FALSE,
    group_name VARCHAR(200),
    timestamp TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_messages_client_id ON messages(client_id);
CREATE INDEX idx_messages_timestamp ON messages(timestamp DESC);
CREATE INDEX idx_messages_direction ON messages(direction);

-- LLM-triaged tasks derived from messages
CREATE TABLE tasks (
    id SERIAL PRIMARY KEY,
    client_id INTEGER REFERENCES clients(id),
    source_message_ids INTEGER[],       -- array of message IDs that formed this task
    category VARCHAR(30) NOT NULL CHECK (category IN (
        'feature_request', 'bug_report', 'urgent_issue',
        'billing_question', 'general_query', 'onboarding_help'
    )),
    priority VARCHAR(10) NOT NULL CHECK (priority IN ('critical', 'high', 'medium', 'low')),
    summary TEXT NOT NULL,              -- LLM-generated one-liner
    context TEXT,                       -- LLM-generated longer summary of recent happenings
    draft_response TEXT,                -- LLM-suggested response
    status VARCHAR(20) DEFAULT 'open' CHECK (status IN (
        'open', 'in_progress', 'waiting_on_client', 'resolved', 'dismissed'
    )),
    assigned_to INTEGER REFERENCES team_members(id),
    alert_sent BOOLEAN DEFAULT FALSE,   -- whether urgent alert call was placed
    resolved_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_tasks_client_id ON tasks(client_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_priority ON tasks(priority);
CREATE INDEX idx_tasks_category ON tasks(category);

-- Audit log for dashboard actions (who sent what, who resolved what)
CREATE TABLE activity_log (
    id SERIAL PRIMARY KEY,
    team_member_id INTEGER REFERENCES team_members(id),
    action VARCHAR(50) NOT NULL,        -- 'sent_reply', 'resolved_task', 'escalated', 'called_poc'
    target_type VARCHAR(20),            -- 'task', 'message', 'client'
    target_id INTEGER,
    details JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

-- View: Client health overview (used by dashboard)
CREATE VIEW client_health AS
SELECT
    c.id,
    c.name,
    c.org_name,
    c.phone,
    c.status,
    tm.name AS poc_name,
    tm.phone AS poc_phone,
    -- Last inbound message time
    (SELECT MAX(m.timestamp) FROM messages m WHERE m.client_id = c.id AND m.direction = 'inbound') AS last_client_message_at,
    -- Last outbound (our reply) time
    (SELECT MAX(m.timestamp) FROM messages m WHERE m.client_id = c.id AND m.direction = 'outbound') AS last_reply_at,
    -- Open task count
    (SELECT COUNT(*) FROM tasks t WHERE t.client_id = c.id AND t.status IN ('open', 'in_progress')) AS open_tasks,
    -- Has urgent?
    (SELECT COUNT(*) > 0 FROM tasks t WHERE t.client_id = c.id AND t.status = 'open' AND t.priority = 'critical') AS has_urgent
FROM clients c
LEFT JOIN team_members tm ON c.poc_id = tm.id;

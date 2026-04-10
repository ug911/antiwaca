// ============================================
// WACA - WhatsApp Client Tracker Agent - Database Connection
// Supports local Postgres or cloud providers via DATABASE_URL
// ============================================
//
// Cloud providers (all give you a connection string):
//   - Neon (neon.tech)       — free serverless Postgres
//   - Supabase               — free Postgres + UI
//   - ElephantSQL            — free "Tiny Turtle" plan
//   - Railway                — free trial Postgres
//
// Set DATABASE_URL in .env for cloud, or use DB_HOST/DB_PORT/etc for local.

const { Pool } = require('pg');
require('dotenv').config();

const poolConfig = process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        // Cloud providers require SSL
        ssl: process.env.DB_SSL === 'false'
            ? false
            : { rejectUnauthorized: false },
    }
    : {
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT || 5432,
        database: process.env.DB_NAME || 'wise_tracker',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || 'postgres',
    };

const db = new Pool(poolConfig);

function getDbInfo() {
    if (process.env.DATABASE_URL) {
        // Mask credentials in the URL for logging
        try {
            const u = new URL(process.env.DATABASE_URL);
            return `${u.protocol}//${u.host}${u.pathname}`;
        } catch {
            return 'cloud (DATABASE_URL)';
        }
    }
    return `${poolConfig.host}:${poolConfig.port}/${poolConfig.database}`;
}

module.exports = { db, getDbInfo };

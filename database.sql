CREATE DATABASE tiktok_game;

\c tiktok_game;

CREATE TABLE streamers (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) UNIQUE NOT NULL,
    total_likes_alltime BIGINT DEFAULT 0
);

CREATE TABLE weekly_likes (
    streamer_id INTEGER REFERENCES streamers(id) ON DELETE CASCADE,
    week_start DATE NOT NULL,
    weekly_likes BIGINT DEFAULT 0,
    PRIMARY KEY (streamer_id, week_start)
);

CREATE TABLE subscriptions (
    user_id VARCHAR(255) PRIMARY KEY,
    is_active BOOLEAN DEFAULT true,
    start_date TIMESTAMP DEFAULT NOW(),
    end_date TIMESTAMP,
    boost_multiplier INTEGER DEFAULT 2
);

CREATE TABLE live_sessions (
    id SERIAL PRIMARY KEY,
    streamer_id INTEGER REFERENCES streamers(id),
    start_time TIMESTAMP DEFAULT NOW(),
    end_time TIMESTAMP,
    total_likes_session BIGINT DEFAULT 0
);

CREATE TABLE viewer_likes_archive (
    user_id VARCHAR(255),
    week_start DATE,
    likes_given BIGINT,
    PRIMARY KEY (user_id, week_start)
);

// Preloaded into every test process (`node --require`): the dev SESSION_SECRET fallback is only
// allowed when NODE_ENV is explicitly "development" or "test".
process.env.NODE_ENV ??= 'test';

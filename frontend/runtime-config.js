// Runtime configuration, loaded BEFORE the app. The deploy pipeline overwrites this file per environment, so the same build runs in
// staging and production. Nothing secret belongs here: everything in this file is visible to every visitor.
//
//   window.FINTRACK_CONFIG = { apiBaseUrl: 'https://api.example.com/api' };
//
// With no value the app talks to http://localhost:5000/api (local development).
window.FINTRACK_CONFIG = window.FINTRACK_CONFIG || {};

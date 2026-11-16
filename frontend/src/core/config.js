// Central frontend configuration. Nothing secret lives here (a browser app cannot keep secrets).
// To point the app at another backend without editing code, define before main.js loads:
//   <script>window.FINTRACK_CONFIG = { apiBaseUrl: 'https://api.example.com/api' }</script>

const override = (typeof window !== 'undefined' && window.FINTRACK_CONFIG) || {};

export const API_BASE_URL = override.apiBaseUrl || 'http://localhost:5000/api';
export const REQUEST_TIMEOUT_MS = override.requestTimeoutMs || 20000;
export const LOGIN_PAGE = 'login.html';
export const CURRENCY_SYMBOL = '৳';

// Keys kept compatible with the previous version so existing sessions survive the upgrade.
export const STORAGE_KEYS = {
  token: 'fintrack_token',
  user: 'fintrack_user',
  theme: 'fintrack_theme',
  sidebar: 'fintrack_sidebar',
};

export const CATEGORIES = [
  ['Food', 'Food & Dining'],
  ['Transport', 'Transport'],
  ['Shopping', 'Shopping'],
  ['Entertainment', 'Entertainment'],
  ['Education', 'Education'],
  ['Bills', 'Bills & Utilities'],
  ['Healthcare', 'Healthcare'],
  ['Salary', 'Salary & Income'],
  ['Others', 'Others'],
];

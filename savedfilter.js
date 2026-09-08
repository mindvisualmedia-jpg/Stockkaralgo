'use strict';
// Saved-screener guard (2026-09-08).
//
// stockkar.in has NO "stocks for saved filter X" endpoint: its page downloads
// the filter config and its frontend translates it into a stocks query.
// savedfilter-query.js is a faithful port of that translation; this module
// answers one question for the guard in server.js: does the port act on (or,
// like the site, deliberately ignore) every filter name this saved screener
// carries? A name the port has never seen used to be silently DROPPED - a less
// restrictive query, a wider universe, wrong stocks. It is refused instead, by
// name, so the mapping gets added before a basket is ever loaded.
//
// Pure and dependency-free (beyond the port) so it unit-tests without a server.

const { HANDLED_FILTER_NAMES, normalizeActiveFilterNames } = require('./savedfilter-query');

// Names are compared EXACTLY after the site's own legacy-name normalisation -
// that is how the page matches them (activeFilters.includes(name)).
function unknownSavedFilterNames(activeFilters, handled = HANDLED_FILTER_NAMES) {
  return normalizeActiveFilterNames(activeFilters)
    .map(n => String(n || '').trim())
    .filter(n => n && !handled.includes(n));
}

module.exports = { unknownSavedFilterNames, HANDLED_FILTER_NAMES };

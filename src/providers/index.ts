// Host-side provider container-config barrel.
// Providers that need host-side container setup (extra mounts, env passthrough,
// per-session directories) self-register on import. Providers with no host
// needs (claude) don't appear here.
//
// Skills add a new provider by appending one import line below.
//
// `claude` is here despite having no custom-endpoint config on a standard
// install: it also contributes the host's `claude` path, which a host-driver
// session needs. Its contribution is empty when neither applies.
import './claude.js';

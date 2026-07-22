// Minimal in-browser module registry. Each section file calls
// defineModule(name, deps, factory) exactly once; deps are resolved eagerly
// against modules that have already registered, so a missing/out-of-order
// <script> tag fails loudly instead of silently handing back `undefined`.
window.Modules = {};
window.defineModule = function defineModule(name, deps, factory) {
  const resolved = deps.map(dep => {
    if (!(dep in window.Modules)) {
      throw new Error(`module "${name}" depends on "${dep}", which hasn't loaded yet`);
    }
    return window.Modules[dep];
  });
  window.Modules[name] = factory(...resolved);
};

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

const debug = require('debug')('plugin:ensure');
const filtrex = require('filtrex').compileExpression;

class EnsurePlugin {
  constructor(script, events) {

    // If running in Artillery v1, do nothing
    // If running in Artillery v2, we only want to run on the main thread

    if (!global.artillery) {
      debug('Running in an unsupported Artillery version, nothing to do');
      return;
    }
    if (global.artillery &&
        Number(global.artillery.version.slice(0, 1)) === 1) {
      debug('Running in Artillery v1, nothing to do')
      return;
    }

    if (global.artillery &&
        Number(global.artillery.version.slice(0, 1)) > 1 &&
        typeof process.env.LOCAL_WORKER_ID !== 'undefined') {
      debug('Running in a worker, nothing to do')
      return;
    }

    debug('plugin loaded');

    this.script = script;
    this.events = events;

    const checks = this.script.config.ensure || this.script.plugins.ensure;

    global.artillery.ext(
      {
        ext: 'beforeExit',
        method: async (data) => {

          if (typeof this.script?.config?.ensure === 'undefined' ||
              typeof process.env.ARTILLERY_DISABLE_ENSURE !== 'undefined') {
            return;
          }

          debug(JSON.stringify(data));
          const vars = Object.assign({}, global.artillery.apdexPlugin || {}, EnsurePlugin.statsToVars(data));
          debug({vars});

          const checkTests = EnsurePlugin.runChecks(checks, vars);

          global.artillery.globalEvents.emit('checks', checkTests);

          checkTests.forEach(check => {
            if(check.result !== 1) {
              global.artillery.log(`fail: ${check.original}${check.strict ? '': ' (optional)'}`);
              if(check.strict) {
                global.artillery.suggestedExitCode = 1;
              }
            } else {
              global.artillery.log(`ok: ${check.original}`);
            }
          });
        }
      }
    );
  }

  // Combine counters/rates/summaries into a flat key->value object for filtrex
  static statsToVars(data) {
    const vars = Object.assign({}, data.report.counters, data.report.rates);
    for(const [name, values] of Object.entries(data.report.summaries || {})) {
      for(const [aggregation, value] of Object.entries(values)) {
        vars[`${name}.${aggregation}`] = value;
      }
    }

    return vars;
  }

  static runChecks(checks, vars) {
    const LEGACY_CONDITIONS = ['min', 'max', 'median', 'p95', 'p99'];
    const checkTests = [];

    if (Array.isArray(checks.thresholds)) {
      checks.thresholds.forEach((o) => {
        if (typeof o === 'object') {
          const metricName = Object.keys(o)[0]; // only one metric check per array entry
          const maxValue = o[metricName];
          const expr = `${metricName} < ${maxValue}`;
          let f = () => {};
          try {
            f = filtrex(expr);
          } catch (err) {
            global.artillery.log(err);
          }

          // all threshold checks are strict:
          checkTests.push({ f, strict: true, original: expr });
        }
      });
    }

    if (Array.isArray(checks.conditions)) {
      checks.conditions.forEach((o) => {
        if (typeof o === 'object') {
          const expression = o.expression;
          const strict = typeof o.strict === 'boolean' ? o.strict : true;

          let f = () => {};
          try {
            f = filtrex(expression);
          } catch (err) {
            global.artillery.log(err);
          }

          checkTests.push({ f, strict, original: expression });
        }
      });
    }

    Object.keys(checks)
      .filter(k => LEGACY_CONDITIONS.indexOf(k) > -1)
      .forEach(k => {
        const metricName = `http.response_time.${k}`;
        const maxValue = parseInt(checks[k]);
        let f = () => {};
        try {
          f = filtrex(`${metricName} < ${maxValue}`);
        } catch (err) {
          global.artillery.log(err);
        }

        // all legacy threshold checks are strict:
        checkTests.push({ f, strict: true, original: `${k} < ${maxValue}` });
      });

    if(typeof checks.maxErrorRate !== 'undefined') {
      const maxValue = Number(checks.maxErrorRate);
      const expression = `((vusers.created - vusers.completed)/vusers.created * 100) <= ${maxValue}`;
      let f = () => {};
      try {
        f = filtrex(expression);
      } catch (err) {
        global.artillery.log(err);
      }

      checkTests.push({ f, strict: true, original: `maxErrorRate < ${maxValue}` });
    }

    if(checkTests.length > 0) {
      global.artillery.log('\nChecks:');
    }

    checkTests.forEach(check => {
      const result = check.f(vars);
      check.result = result;
      debug(`check ${check.original} -> ${result}`);
    });
    return checkTests;
  }
}

module.exports = {
  Plugin: EnsurePlugin,
};

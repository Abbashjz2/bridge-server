function loadStaticSnmpTargets(env = process.env) {
  const raw = env.SNMP_TARGETS_JSON || '[]';
  let value;
  try { value = JSON.parse(raw); }
  catch (e) { throw new Error(`SNMP_TARGETS_JSON is invalid JSON: ${e.message}`); }
  if (!Array.isArray(value)) throw new Error('SNMP_TARGETS_JSON must be a JSON array');
  return value.filter((x) => x && x.host);
}
module.exports = { loadStaticSnmpTargets };

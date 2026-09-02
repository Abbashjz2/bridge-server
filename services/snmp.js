const snmp = require('net-snmp');

const OIDS = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysObjectID: '1.3.6.1.2.1.1.2.0',
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  sysName: '1.3.6.1.2.1.1.5.0',

  ifDescr: '1.3.6.1.2.1.2.2.1.2',
  ifSpeed: '1.3.6.1.2.1.2.2.1.5',
  ifAdminStatus: '1.3.6.1.2.1.2.2.1.7',
  ifOperStatus: '1.3.6.1.2.1.2.2.1.8',
  ifInOctets: '1.3.6.1.2.1.2.2.1.10',
  ifInErrors: '1.3.6.1.2.1.2.2.1.14',
  ifOutOctets: '1.3.6.1.2.1.2.2.1.16',
  ifOutErrors: '1.3.6.1.2.1.2.2.1.20',
  ifName: '1.3.6.1.2.1.31.1.1.1.1',
  ifHighSpeed: '1.3.6.1.2.1.31.1.1.1.15',

  // HOST-RESOURCES-MIB. RouterOS exposes /system resource values here.
  hrProcessorLoad: '1.3.6.1.2.1.25.3.3.1.2',
  hrStorageType: '1.3.6.1.2.1.25.2.3.1.2',
  hrStorageAllocationUnits: '1.3.6.1.2.1.25.2.3.1.4',
  hrStorageSize: '1.3.6.1.2.1.25.2.3.1.5',
  hrStorageUsed: '1.3.6.1.2.1.25.2.3.1.6',
  hrStorageRam: '1.3.6.1.2.1.25.2.1.2',
};

function valueToJs(value) {
  if (Buffer.isBuffer(value)) return value.toString('utf8').replace(/\0+$/g, '');
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function normalizeOidValue(value) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/^\./, '');
}

function normalizeVersion(value) {
  const v = String(value || '2c').toLowerCase();
  if (v === '2' || v === '2c' || v === 'v2c') return '2c';
  if (v === '3' || v === 'v3') return '3';
  throw new Error(`Unsupported SNMP version: ${value}`);
}

function createSession(target) {
  const version = normalizeVersion(target.version);
  const options = {
    port: Number(target.port || 161),
    retries: Number(target.retries ?? 1),
    timeout: Number(target.timeout_ms || 3000),
    transport: target.transport || 'udp4',
    backoff: 1.5,
  };

  if (version === '2c') {
    options.version = snmp.Version2c;
    return snmp.createSession(target.host, target.community || 'public', options);
  }

  options.version = snmp.Version3;
  const levelName = String(target.security_level || 'authPriv');
  const level = snmp.SecurityLevel[levelName];
  if (level === undefined) throw new Error(`Invalid SNMPv3 security level: ${levelName}`);

  const user = { name: target.username, level };
  if (!user.name) throw new Error('SNMPv3 username is required');

  if (levelName !== 'noAuthNoPriv') {
    const authName = String(target.auth_protocol || 'sha').toLowerCase();
    user.authProtocol = authName === 'md5' ? snmp.AuthProtocols.md5 : snmp.AuthProtocols.sha;
    user.authKey = target.auth_key;
    if (!user.authKey) throw new Error('SNMPv3 auth_key is required');
  }

  if (levelName === 'authPriv') {
    const privName = String(target.priv_protocol || 'aes').toLowerCase();
    user.privProtocol = privName === 'des' ? snmp.PrivProtocols.des : snmp.PrivProtocols.aes;
    user.privKey = target.priv_key;
    if (!user.privKey) throw new Error('SNMPv3 priv_key is required');
  }

  return snmp.createV3Session(target.host, user, options);
}

function get(session, oids) {
  return new Promise((resolve, reject) => {
    session.get(oids, (error, varbinds) => {
      if (error) return reject(error);
      const result = {};
      for (const vb of varbinds || []) {
        if (snmp.isVarbindError(vb)) continue;
        result[vb.oid] = valueToJs(vb.value);
      }
      resolve(result);
    });
  });
}

function subtree(session, oid) {
  return new Promise((resolve, reject) => {
    const rows = [];
    session.subtree(
      oid,
      20,
      (varbinds) => {
        for (const vb of varbinds || []) {
          if (!snmp.isVarbindError(vb)) rows.push({ oid: vb.oid, value: valueToJs(vb.value) });
        }
      },
      (error) => (error ? reject(error) : resolve(rows))
    );
  });
}

function indexFromOid(base, oid) {
  return String(oid).slice(base.length + 1);
}

async function withSession(target, fn) {
  const session = createSession(target);
  try {
    return await fn(session);
  } finally {
    try { session.close(); } catch {}
  }
}

async function getSystemInfo(target) {
  return withSession(target, async (session) => {
    const values = await get(session, [OIDS.sysDescr, OIDS.sysObjectID, OIDS.sysUpTime, OIDS.sysName]);
    return {
      sys_name: values[OIDS.sysName] ?? null,
      sys_descr: values[OIDS.sysDescr] ?? null,
      sys_object_id: values[OIDS.sysObjectID] ?? null,
      sys_uptime_ticks: values[OIDS.sysUpTime] ?? null,
    };
  });
}

async function getInterfaces(target) {
  return withSession(target, async (session) => {
    const [descr, names, speed, highSpeed, admin, oper, inOctets, outOctets, inErrors, outErrors] = await Promise.all([
      subtree(session, OIDS.ifDescr),
      subtree(session, OIDS.ifName),
      subtree(session, OIDS.ifSpeed),
      subtree(session, OIDS.ifHighSpeed),
      subtree(session, OIDS.ifAdminStatus),
      subtree(session, OIDS.ifOperStatus),
      subtree(session, OIDS.ifInOctets),
      subtree(session, OIDS.ifOutOctets),
      subtree(session, OIDS.ifInErrors),
      subtree(session, OIDS.ifOutErrors),
    ]);

    const map = new Map();
    const apply = (rows, base, key) => {
      for (const row of rows) {
        const idx = indexFromOid(base, row.oid);
        if (!map.has(idx)) map.set(idx, { index: Number(idx) });
        map.get(idx)[key] = row.value;
      }
    };

    apply(descr, OIDS.ifDescr, 'description');
    apply(names, OIDS.ifName, 'name');
    apply(speed, OIDS.ifSpeed, 'speed_bps');
    apply(highSpeed, OIDS.ifHighSpeed, 'high_speed_mbps');
    apply(admin, OIDS.ifAdminStatus, 'admin_status');
    apply(oper, OIDS.ifOperStatus, 'oper_status');
    apply(inOctets, OIDS.ifInOctets, 'rx_octets');
    apply(outOctets, OIDS.ifOutOctets, 'tx_octets');
    apply(inErrors, OIDS.ifInErrors, 'rx_errors');
    apply(outErrors, OIDS.ifOutErrors, 'tx_errors');

    return [...map.values()]
      .sort((a, b) => a.index - b.index)
      .map((row) => ({
        ...row,
        display_name: row.name || row.description || `if${row.index}`,
        link_up: Number(row.oper_status) === 1,
        admin_up: Number(row.admin_status) === 1,
        negotiated_mbps:
          Number(row.high_speed_mbps || 0) ||
          (Number(row.speed_bps || 0) / 1_000_000) ||
          null,
      }));
  });
}

function isMikroTik(target, system) {
  const vendor = String(target?.vendor || '').trim().toLowerCase();
  const objectId = normalizeOidValue(system?.sys_object_id);
  const descr = String(system?.sys_descr || '').toLowerCase();
  return vendor === 'mikrotik' || objectId.startsWith('1.3.6.1.4.1.14988') || descr.includes('routeros');
}

async function getMikroTikMetrics(target) {
  return withSession(target, async (session) => {
    const [cpuRows, typeRows, unitRows, sizeRows, usedRows] = await Promise.all([
      subtree(session, OIDS.hrProcessorLoad),
      subtree(session, OIDS.hrStorageType),
      subtree(session, OIDS.hrStorageAllocationUnits),
      subtree(session, OIDS.hrStorageSize),
      subtree(session, OIDS.hrStorageUsed),
    ]);

    const cpuValues = cpuRows
      .map((row) => Number(row.value))
      .filter((value) => Number.isFinite(value) && value >= 0 && value <= 100);

    const cpuPercent = cpuValues.length
      ? Number((cpuValues.reduce((sum, value) => sum + value, 0) / cpuValues.length).toFixed(1))
      : null;

    const storage = new Map();
    const apply = (rows, base, field) => {
      for (const row of rows) {
        const idx = indexFromOid(base, row.oid);
        if (!storage.has(idx)) storage.set(idx, { index: idx });
        storage.get(idx)[field] = row.value;
      }
    };

    apply(typeRows, OIDS.hrStorageType, 'type');
    apply(unitRows, OIDS.hrStorageAllocationUnits, 'allocation_units');
    apply(sizeRows, OIDS.hrStorageSize, 'size_units');
    apply(usedRows, OIDS.hrStorageUsed, 'used_units');

    let ramRow = [...storage.values()].find(
      (row) => normalizeOidValue(row.type) === OIDS.hrStorageRam
    );

    // RouterOS has historically exposed RAM at index 65536. Keep this only
    // as a compatibility fallback if hrStorageType is absent on an older box.
    if (!ramRow) ramRow = storage.get('65536') || null;

    let memoryPercent = null;
    let totalMemoryBytes = null;
    let usedMemoryBytes = null;
    let freeMemoryBytes = null;

    if (ramRow) {
      const allocationUnits = Number(ramRow.allocation_units);
      const sizeUnits = Number(ramRow.size_units);
      const usedUnits = Number(ramRow.used_units);

      if (
        Number.isFinite(allocationUnits) && allocationUnits > 0 &&
        Number.isFinite(sizeUnits) && sizeUnits > 0 &&
        Number.isFinite(usedUnits) && usedUnits >= 0
      ) {
        totalMemoryBytes = allocationUnits * sizeUnits;
        usedMemoryBytes = allocationUnits * usedUnits;
        freeMemoryBytes = Math.max(0, totalMemoryBytes - usedMemoryBytes);
        memoryPercent = Number(((usedMemoryBytes / totalMemoryBytes) * 100).toFixed(1));
      }
    }

    return {
      source: 'snmp',
      profile: 'mikrotik',
      cpu_percent: cpuPercent,
      memory_percent: memoryPercent,
      total_memory_bytes: totalMemoryBytes,
      used_memory_bytes: usedMemoryBytes,
      free_memory_bytes: freeMemoryBytes,
    };
  });
}

async function getDeviceMetrics(target, system) {
  if (isMikroTik(target, system)) return getMikroTikMetrics(target);
  return null;
}

async function pollTarget(target) {
  const started = Date.now();
  const [system, interfaces] = await Promise.all([
    getSystemInfo(target),
    getInterfaces(target),
  ]);

  let metrics = null;
  const collectDeviceMetrics =
    target.collect_device_metrics !== false ||
    target.alert_high_cpu === true ||
    target.alert_high_memory === true;

  if (collectDeviceMetrics) {
    // Device metrics feed canonical health as well as optional alerts. A
    // missing vendor metric must not make interface/system SNMP polling look
    // unreachable.
    try {
      metrics = await getDeviceMetrics(target, system);
    } catch (error) {
      metrics = {
        source: 'snmp',
        error: error.message,
      };
    }
  }

  return {
    ok: true,
    host: target.host,
    name: target.name || system.sys_name || target.host,
    system,
    interfaces,
    metrics,
    duration_ms: Date.now() - started,
  };
}

module.exports = {
  OIDS,
  createSession,
  getSystemInfo,
  getInterfaces,
  getMikroTikMetrics,
  getDeviceMetrics,
  pollTarget,
};

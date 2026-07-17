const os = require('node:os');
const fs = require('node:fs/promises');

const HOST_ROOT_PATH = '/host/root';
const PI_MODEL_PATH =
    '/host/proc/device-tree/model';
const OS_RELEASE_PATH =
    '/host/etc/os-release';

function round(value, digits = 2) {
    if (!Number.isFinite(value)) {
        return null;
    }

    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function bytesToMb(bytes) {
    return round(bytes / 1024 / 1024);
}

function bytesToGb(bytes) {
    return round(bytes / 1024 / 1024 / 1024);
}

function calculatePercent(used, total) {
    if (
        !Number.isFinite(used) ||
        !Number.isFinite(total) ||
        total <= 0
    ) {
        return null;
    }

    return round(
        Math.min(100, Math.max(0, (used / total) * 100))
    );
}

async function readTextFile(path) {
    try {
        const value = await fs.readFile(path, 'utf8');

        return value
            .replace(/\0/g, '')
            .trim();
    } catch {
        return null;
    }
}

async function getCpuTemperature() {
    const paths = [
        '/host/sys/class/thermal/thermal_zone0/temp',
        '/host/sys/devices/virtual/thermal/thermal_zone0/temp',
    ];

    for (const temperaturePath of paths) {
        try {
            const raw = await fs.readFile(
                temperaturePath,
                'utf8'
            );

            const millidegrees = Number(raw.trim());

            if (Number.isFinite(millidegrees)) {
                return Number(
                    (millidegrees / 1000).toFixed(2)
                );
            }
        } catch {
            // Try the next path.
        }
    }

    return null;
}

function getCpuSnapshot() {
    const cpus = os.cpus();

    let idle = 0;
    let total = 0;

    for (const cpu of cpus) {
        const times = cpu.times || {};

        const cpuTotal =
            (times.user || 0) +
            (times.nice || 0) +
            (times.sys || 0) +
            (times.idle || 0) +
            (times.irq || 0);

        idle += times.idle || 0;
        total += cpuTotal;
    }

    return {
        idle,
        total
    };
}

function delay(milliseconds) {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

async function getCpuUsage(sampleTimeMs = 500) {
    const first = getCpuSnapshot();

    await delay(sampleTimeMs);

    const second = getCpuSnapshot();

    const idleDifference = second.idle - first.idle;
    const totalDifference = second.total - first.total;

    if (totalDifference <= 0) {
        return null;
    }

    return round(
        Math.min(
            100,
            Math.max(
                0,
                (1 - idleDifference / totalDifference) * 100
            )
        )
    );
}

function getMemoryMetrics() {
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const usedBytes = Math.max(0, totalBytes - freeBytes);

    return {
        used_bytes: usedBytes,
        total_bytes: totalBytes,
        free_bytes: freeBytes,

        used_mb: bytesToMb(usedBytes),
        total_mb: bytesToMb(totalBytes),
        free_mb: bytesToMb(freeBytes),

        used_gb: bytesToGb(usedBytes),
        total_gb: bytesToGb(totalBytes),
        free_gb: bytesToGb(freeBytes),

        used_percent: calculatePercent(
            usedBytes,
            totalBytes
        )
    };
}

async function getDiskMetrics() {
    try {
        const stats = await fs.statfs(HOST_ROOT_PATH, {
            bigint: true
        });

        const blockSize = stats.bsize;
        const totalBytes = stats.blocks * blockSize;
        const freeBytes = stats.bavail * blockSize;
        const usedBytes = totalBytes - freeBytes;

        const total = Number(totalBytes);
        const free = Number(freeBytes);
        const used = Number(usedBytes);

        return {
            path: HOST_ROOT_PATH,

            used_bytes: used,
            total_bytes: total,
            free_bytes: free,

            used_mb: bytesToMb(used),
            total_mb: bytesToMb(total),
            free_mb: bytesToMb(free),

            used_gb: bytesToGb(used),
            total_gb: bytesToGb(total),
            free_gb: bytesToGb(free),

            used_percent: calculatePercent(
                used,
                total
            )
        };
    } catch (error) {
        return {
            path: HOST_ROOT_PATH,
            error: error.message
        };
    }
}

function parseOsRelease(contents) {
    if (!contents) {
        return null;
    }

    const values = {};

    for (const line of contents.split('\n')) {
        const separatorIndex = line.indexOf('=');

        if (separatorIndex === -1) {
            continue;
        }

        const key = line
            .slice(0, separatorIndex)
            .trim();

        let value = line
            .slice(separatorIndex + 1)
            .trim();

        value = value.replace(/^["']|["']$/g, '');

        values[key] = value;
    }

    return {
        name: values.NAME || null,
        pretty_name: values.PRETTY_NAME || null,
        version: values.VERSION || null,
        version_id: values.VERSION_ID || null
    };
}

async function getSystemMetrics() {
    const [
        cpuUsagePercent,
        cpuTemperatureCelsius,
        disk,
        piModel,
        osReleaseContents
    ] = await Promise.all([
        getCpuUsage(),
        getCpuTemperature(),
        getDiskMetrics(),
        readTextFile(PI_MODEL_PATH),
        readTextFile(OS_RELEASE_PATH)
    ]);

    const cpus = os.cpus();
    const firstCpu = cpus[0] || {};
    const loadAverage = os.loadavg();

    return {
        collected_at: new Date().toISOString(),

        system: {
            hostname: os.hostname(),
            platform: os.platform(),
            architecture: os.arch(),
            kernel_release: os.release(),
            system_uptime_seconds: Math.floor(os.uptime()),
            node_version: process.version,
            raspberry_pi_model: piModel,
            operating_system: parseOsRelease(
                osReleaseContents
            )
        },

        cpu: {
            model: firstCpu.model || null,
            logical_cores: cpus.length,
            speed_mhz:
                Number.isFinite(firstCpu.speed)
                    ? firstCpu.speed
                    : null,
            usage_percent: cpuUsagePercent,
            temperature_celsius:
                cpuTemperatureCelsius,
            load_average_1m: loadAverage[0],
            load_average_5m: loadAverage[1],
            load_average_15m: loadAverage[2]
        },

        memory: getMemoryMetrics(),

        disk
    };
}

module.exports = {
    getSystemMetrics
};
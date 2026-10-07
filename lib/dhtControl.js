'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { raspberryGeneration } = require('./gpioControl');

// The dht11 kernel driver (enabled with `dtoverlay=dht11,gpiopin=<n>` in config.txt) registers
// one industrial I/O device per sensor here. It handles DHT11, DHT21, DHT22 and AM2302 alike.
const IIO_ROOT = '/sys/bus/iio/devices';
const MODEL_FILE = '/proc/device-tree/model';

// Datasheet minimum time between two measurements, by sensor type.
const MIN_POLL_INTERVAL = { 11: 1000, 22: 2000 };
// Used when no poll interval is configured.
const DEFAULT_POLL_INTERVAL = 30000;
// Single failed reads are normal for DHT sensors, only report once a sensor fails repeatedly.
const FAILURES_BEFORE_ERROR = 3;
// While a sensor keeps failing, remind about it every this many failed reads.
const FAILURE_REMINDER_EVERY = 50;
// The kernel driver does not retry on its own and reports EIO/ETIMEDOUT quite often.
const KERNEL_READ_ATTEMPTS = 3;
// After a failure the kernel driver measures again right away; the sensor needs 2s in between.
const KERNEL_RETRY_DELAY = 2100;
// node-dht-sensor retries internally (about 2s worst case). Much longer means the read got stuck.
const LIBRARY_READ_TIMEOUT = 15000;

/**
 * @param port {number|string}
 * @returns {string} id of the temperature state of a DHT port
 */
function temperatureStateName(port) {
    return `gpio.${port}.temperature`;
}

/**
 * @param port {number|string}
 * @returns {string} id of the humidity state of a DHT port
 */
function humidityStateName(port) {
    return `gpio.${port}.humidity`;
}

/**
 * @param err {unknown}
 * @returns {string} printable error message
 */
function errorText(err) {
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
}

/**
 * Read a sysfs / procfs text file. Device tree strings are NUL terminated.
 *
 * @param file {string}
 * @returns {Promise<string>} the trimmed content
 */
async function readTrimmed(file) {
    return (await fs.readFile(file, 'utf8')).replace(/\0/g, '').trim();
}

/**
 * @param file {string}
 * @returns {Promise<string>} board model, empty if unknown
 */
async function readBoardModel(file = MODEL_FILE) {
    try {
        return await readTrimmed(file);
    } catch {
        return '';
    }
}

/**
 * Check if an iio device belongs to the dht11 kernel driver. The device name is the device tree
 * node name (`dht11@11`), the compatible string is checked as well in case a board names it differently.
 *
 * @param dir {string} the iio:deviceN directory
 * @param name {string} content of its name attribute
 * @returns {Promise<boolean>} true for a dht11 kernel device
 */
async function isKernelDht(dir, name) {
    if (/^dht11(@|$)/.test(name)) {
        return true;
    }
    for (const rel of ['of_node/compatible', 'device/of_node/compatible']) {
        try {
            if ((await fs.readFile(path.join(dir, rel), 'latin1')).split('\0').includes('dht11')) {
                return true;
            }
        } catch {
            // not available here, try the next location
        }
    }
    return false;
}

/**
 * Find the GPIO line a dht11 kernel device is attached to. The device tree node carries it in its
 * `gpios` property (phandle, line, flags as big endian 32 bit cells). The overlay also puts it into
 * the node name as unit address (`dht11@11` for GPIO 17), but only if `gpiopin=` was given, so the
 * name is a fallback only.
 *
 * @param dir {string} the iio:deviceN directory
 * @param name {string} content of its name attribute
 * @returns {Promise<{gpio: number, source: string, details: string[]}>} gpio is NaN if not found
 */
async function gpioOfKernelDevice(dir, name) {
    const details = [`name="${name}"`];
    for (const rel of ['of_node/gpios', 'device/of_node/gpios']) {
        try {
            const cells = await fs.readFile(path.join(dir, rel));
            details.push(`${rel}=<${cells.toString('hex').replace(/(.{8})(?!$)/g, '$1 ')}>`);
            if (cells.length >= 8) {
                return { gpio: cells.readUInt32BE(4), source: rel, details };
            }
        } catch (err) {
            details.push(`${rel}: ${errorText(err)}`);
        }
    }

    const names = [name];
    try {
        const real = await fs.realpath(dir);
        details.push(`path=${real}`);
        names.push(path.basename(path.dirname(real)));
    } catch (err) {
        details.push(`realpath: ${errorText(err)}`);
    }
    for (const candidate of names) {
        const match = /^dht11@([0-9a-f]+)$/i.exec(candidate);
        if (match) {
            return { gpio: parseInt(match[1], 16), source: `node name ${candidate}`, details };
        }
    }
    return { gpio: NaN, source: '', details };
}

/**
 * Look for sensors handled by the dht11 kernel driver.
 *
 * @param root {string} iio device directory
 * @param log {ioBroker.Logger}
 * @returns {Promise<{byGpio: Map<number, string>, unmapped: Array<{dir: string, details: string[]}>}>}
 *  devices by GPIO, plus devices whose GPIO could not be determined
 */
async function findKernelDhtDevices(root, log) {
    const byGpio = new Map();
    const unmapped = [];
    let entries;
    try {
        entries = await fs.readdir(root);
    } catch (err) {
        log.debug(`No kernel iio devices (${errorText(err)}).`);
        return { byGpio, unmapped };
    }

    for (const entry of entries.filter(e => e.startsWith('iio:device')).sort()) {
        const dir = path.join(root, entry);
        let name;
        try {
            name = await readTrimmed(path.join(dir, 'name'));
        } catch (err) {
            log.debug(`Skipping ${dir}: ${errorText(err)}`);
            continue;
        }
        if (!(await isKernelDht(dir, name))) {
            log.debug(`Skipping ${dir}: "${name}" is not a dht11 kernel device.`);
            continue;
        }
        const { gpio, source, details } = await gpioOfKernelDevice(dir, name);
        log.debug(`Kernel dht11 device ${dir}: ${details.join(', ')}`);
        if (Number.isNaN(gpio)) {
            unmapped.push({ dir, details });
        } else {
            log.debug(`Kernel dht11 device ${dir} is on GPIO ${gpio} (from ${source}).`);
            byGpio.set(gpio, dir);
        }
    }
    return { byGpio, unmapped };
}

/**
 * Read a kernel value given in milli units.
 *
 * @param file {string}
 * @returns {Promise<number>} value rounded to one decimal
 */
async function readMilli(file) {
    const raw = await readTrimmed(file);
    const value = Number(raw);
    if (raw === '' || !Number.isFinite(value)) {
        throw new Error(`unexpected content "${raw}" in ${file}`);
    }
    return Math.round(value / 100) / 10;
}

/**
 * Read one measurement from the dht11 kernel driver. Reading the temperature triggers a measurement,
 * the driver keeps it for 2s, so the humidity read right after uses the same one.
 *
 * @param dir {string} the iio:deviceN directory
 * @returns {Promise<{temperature: number, humidity: number}>} the measurement
 */
async function readKernelDht(dir) {
    const temperature = await readMilli(path.join(dir, 'in_temp_input'));
    const humidity = await readMilli(path.join(dir, 'in_humidityrelative_input'));
    return { temperature, humidity };
}

/**
 * Tell which GPIO backend a node-dht-sensor binary was compiled for. The default build talks to the
 * BCM2835 registers directly, which do not exist on a Raspberry Pi 5. Only a build made with
 * `--use_libgpiod=true` drops that code and links libgpiod instead.
 *
 * @param binary {Buffer}
 * @returns {'libgpiod'|'bcm2835'|'unknown'} the backend
 */
function binaryBackend(binary) {
    if (binary.includes('libgpiod.so')) {
        return 'libgpiod';
    }
    if (binary.includes('bcm2835_init')) {
        return 'bcm2835';
    }
    return 'unknown';
}

/**
 * @param resolve {(id: string) => string} module resolver, replaceable for tests
 * @returns {Promise<{version: string, backend: string, error?: string}>} installed node-dht-sensor build
 */
async function detectLibraryBuild(resolve = require.resolve) {
    const info = { version: 'unknown', backend: 'unknown' };
    try {
        const pkgFile = resolve('node-dht-sensor/package.json');
        info.version = JSON.parse(await fs.readFile(pkgFile, 'utf8')).version;
        const binary = await fs.readFile(path.join(path.dirname(pkgFile), 'build', 'Release', 'node_dht_sensor.node'));
        info.backend = binaryBackend(binary);
    } catch (err) {
        info.error = errorText(err);
    }
    return info;
}

/**
 * @param configured {unknown} poll interval from the GPIO table
 * @param type {11|22} sensor type
 * @returns {{interval: number, adjusted?: 'default'|'raised'}} the interval actually used
 */
function effectivePollInterval(configured, type) {
    const value = Number(configured) || 0;
    if (value <= 0) {
        return { interval: DEFAULT_POLL_INTERVAL, adjusted: 'default' };
    }
    if (value < MIN_POLL_INTERVAL[type]) {
        return { interval: MIN_POLL_INTERVAL[type], adjusted: 'raised' };
    }
    return { interval: value };
}

/**
 * Reads DHT11/DHT21/DHT22/AM23xx sensors, either through the dht11 kernel driver (if it is
 * active for the pin) or through node-dht-sensor.
 */
class DhtControl {
    /**
     * @param adapter {ioBroker.Adapter}
     * @param [options] {object} replaceable dependencies, for tests
     * @param [options.iioRoot] {string}
     * @param [options.modelFile] {string}
     * @param [options.loadLibrary] {() => any}
     * @param [options.detectLibrary] {() => Promise<{version: string, backend: string, error?: string}>}
     */
    constructor(adapter, options = {}) {
        this.adapter = adapter;
        this.log = adapter.log;
        this.iioRoot = options.iioRoot || IIO_ROOT;
        this.modelFile = options.modelFile || MODEL_FILE;
        this.loadLibrary = options.loadLibrary || (() => require('node-dht-sensor'));
        this.detectLibrary = options.detectLibrary || (() => detectLibraryBuild());
        this.sensors = [];
        this.timers = [];
        this.library = undefined;
        this.libraryBuild = undefined;
        this.isPi5OrNewer = false;
        this.diagnostics = '';
    }

    /**
     * Set up polling for all configured DHT ports.
     *
     * @param dhtPorts {Array<{gpio: number|string, configuration: string, debounceOrPoll?: unknown}>}
     * @returns {Promise<void>}
     */
    async setup(dhtPorts) {
        if (dhtPorts.length === 0) {
            return;
        }

        const model = await readBoardModel(this.modelFile);
        this.isPi5OrNewer = raspberryGeneration(model) >= 5;
        const kernel = await findKernelDhtDevices(this.iioRoot, this.log);

        this.sensors = dhtPorts.map(port => {
            const gpio = Number(port.gpio);
            const type = port.configuration === 'dht11' ? 11 : 22;
            return {
                gpio,
                type,
                label: `DHT${type} sensor on GPIO ${gpio}`,
                configuredInterval: port.debounceOrPoll,
                kernelDir: kernel.byGpio.get(gpio),
                busy: false,
                failures: 0,
                everRead: false,
            };
        });

        const parts = [`board "${model || 'unknown'}"`];
        parts.push(`kernel dht11 driver on GPIO ${kernel.byGpio.size ? [...kernel.byGpio.keys()].join(', ') : 'none'}`);
        if (this.sensors.some(s => !s.kernelDir)) {
            this.libraryBuild = await this.detectLibrary();
            parts.push(
                `node-dht-sensor ${this.libraryBuild.version} (${this.libraryBuild.backend} build${
                    this.libraryBuild.error ? `, ${this.libraryBuild.error}` : ''
                })`,
            );
            try {
                this.library = this.loadLibrary();
            } catch (err) {
                parts.push(`node-dht-sensor failed to load: ${errorText(err)}`);
                this.log.error(
                    `Cannot load node-dht-sensor: ${errorText(err)}. DHT sensors without the kernel driver cannot be read. ${this.setupHint()}`,
                );
            }
        }
        this.diagnostics = parts.join('; ');
        this.log.info(`DHT sensors: ${this.diagnostics}`);

        for (const { dir, details } of kernel.unmapped) {
            this.log.warn(
                `Found kernel dht11 device ${dir} but could not tell which GPIO it uses, so it is not used. ` +
                    `Please report this together with: ${details.join(', ')}`,
            );
        }
        for (const gpio of kernel.byGpio.keys()) {
            if (!this.sensors.some(s => s.gpio === gpio)) {
                this.log.warn(
                    `The dht11 kernel driver is active on GPIO ${gpio}, but GPIO ${gpio} is not configured as DHT sensor in this adapter. ` +
                        'Is the right GPIO number (BCM, not the physical pin) configured?',
                );
            }
        }

        for (const sensor of this.sensors) {
            this.startSensor(sensor);
        }
    }

    /**
     * Log how a sensor will be read and start polling it.
     *
     * @param sensor {object}
     */
    startSensor(sensor) {
        const { interval, adjusted } = effectivePollInterval(sensor.configuredInterval, sensor.type);
        if (adjusted === 'default') {
            this.log.info(`${sensor.label}: no poll interval configured, using ${interval}ms.`);
        } else if (adjusted === 'raised') {
            this.log.warn(
                `${sensor.label}: poll interval ${sensor.configuredInterval}ms is shorter than the sensor supports, using ${interval}ms.`,
            );
        }

        if (sensor.kernelDir) {
            this.log.info(
                `${sensor.label}: reading through the dht11 kernel driver (${sensor.kernelDir}) every ${interval}ms.`,
            );
        } else if (!this.library) {
            this.log.error(`${sensor.label}: not read, node-dht-sensor is not available. ${this.setupHint(sensor)}`);
            return;
        } else {
            this.log.info(`${sensor.label}: reading through node-dht-sensor every ${interval}ms.`);
            if (this.isPi5OrNewer && this.libraryBuild && this.libraryBuild.backend === 'bcm2835') {
                this.log.error(
                    `${sensor.label}: node-dht-sensor was compiled for the BCM2835 GPIO registers, which a Raspberry Pi 5 does not have - reading will fail. ${this.setupHint(sensor)}`,
                );
            }
        }

        this.timers.push(this.adapter.setInterval(() => this.poll(sensor), interval));
        // don't make people wait a whole interval for the first value (or the first error)
        void this.poll(sensor);
    }

    /**
     * Read a sensor once and update its states.
     *
     * @param sensor {object}
     * @returns {Promise<void>}
     */
    async poll(sensor) {
        if (sensor.busy) {
            this.log.debug(`${sensor.label}: previous read still running, skipping this poll.`);
            return;
        }
        sensor.busy = true;
        try {
            const { temperature, humidity } = sensor.kernelDir
                ? await this.readKernel(sensor)
                : await this.readLibrary(sensor);
            if (!Number.isFinite(temperature) || !Number.isFinite(humidity) || humidity < 0 || humidity > 100) {
                throw new Error(`implausible values: ${temperature}°C, ${humidity}%`);
            }
            await this.recordSuccess(sensor, temperature, humidity);
        } catch (err) {
            this.recordFailure(sensor, err);
        } finally {
            sensor.busy = false;
        }
    }

    /**
     * @param sensor {object}
     * @returns {Promise<{temperature: number, humidity: number}>} the measurement
     */
    async readKernel(sensor) {
        let lastError;
        for (let attempt = 1; attempt <= KERNEL_READ_ATTEMPTS; attempt++) {
            try {
                return await readKernelDht(sensor.kernelDir);
            } catch (err) {
                lastError = err;
                this.log.debug(
                    `${sensor.label}: kernel read attempt ${attempt}/${KERNEL_READ_ATTEMPTS} failed: ${errorText(err)}`,
                );
                if (attempt < KERNEL_READ_ATTEMPTS) {
                    await this.adapter.delay(KERNEL_RETRY_DELAY);
                }
            }
        }
        throw lastError;
    }

    /**
     * @param sensor {object}
     * @returns {Promise<{temperature: number, humidity: number}>} the measurement
     */
    readLibrary(sensor) {
        return new Promise((resolve, reject) => {
            const timeout = this.adapter.setTimeout(() => {
                reject(new Error(`node-dht-sensor did not answer within ${LIBRARY_READ_TIMEOUT}ms`));
            }, LIBRARY_READ_TIMEOUT);
            try {
                this.library.read(sensor.type, sensor.gpio, (err, temperature, humidity) => {
                    this.adapter.clearTimeout(timeout);
                    if (err) {
                        reject(err);
                    } else {
                        resolve({ temperature, humidity });
                    }
                });
            } catch (err) {
                this.adapter.clearTimeout(timeout);
                reject(err);
            }
        });
    }

    /**
     * @param sensor {object}
     * @param temperature {number}
     * @param humidity {number}
     * @returns {Promise<void>}
     */
    async recordSuccess(sensor, temperature, humidity) {
        if (sensor.failures >= FAILURES_BEFORE_ERROR) {
            this.log.info(`${sensor.label}: reading works again after ${sensor.failures} failed attempts.`);
        }
        sensor.failures = 0;
        if (!sensor.everRead) {
            sensor.everRead = true;
            this.log.info(`${sensor.label}: first reading ${temperature}°C, ${humidity}%.`);
        } else {
            this.log.debug(`${sensor.label}: ${temperature}°C, ${humidity}%`);
        }
        await this.adapter.setStateChangedAsync(temperatureStateName(sensor.gpio), temperature, true);
        await this.adapter.setStateChangedAsync(humidityStateName(sensor.gpio), humidity, true);
    }

    /**
     * Single failures are normal for DHT sensors. Log them at debug level, report an error once a
     * sensor keeps failing (with everything needed to diagnose it from a log) and remind about it
     * now and then instead of flooding the log.
     *
     * @param sensor {object}
     * @param err {unknown}
     */
    recordFailure(sensor, err) {
        sensor.failures++;
        const message = errorText(err);
        if (sensor.failures === FAILURES_BEFORE_ERROR) {
            this.log.error(
                `${sensor.label}: ${sensor.failures} reads in a row failed, last error: ${message}. ` +
                    `${sensor.everRead ? 'It worked before. ' : 'It never delivered a value since the adapter started. '}` +
                    `${this.failureHint(sensor, message)} Diagnostics: ${this.diagnostics}`,
            );
        } else if (sensor.failures > FAILURES_BEFORE_ERROR && sensor.failures % FAILURE_REMINDER_EVERY === 0) {
            this.log.warn(`${sensor.label}: still failing, ${sensor.failures} reads in a row. Last error: ${message}`);
        } else {
            this.log.debug(`${sensor.label}: read failed (${sensor.failures} in a row): ${message}`);
        }
    }

    /**
     * @param sensor {object}
     * @param message {string} last error
     * @returns {string} what probably helps for this failure
     */
    failureHint(sensor, message) {
        if (sensor.kernelDir) {
            return (
                'The kernel driver could not get a valid measurement. Occasional "EIO" or "timed out" errors are normal, ' +
                'persistent ones usually mean wiring, power (use 3.3V) or pull-up resistor problems.'
            );
        }
        if (this.isPi5OrNewer && this.libraryBuild && this.libraryBuild.backend !== 'libgpiod') {
            return this.setupHint(sensor);
        }
        if (/initiali[sz]e/i.test(message)) {
            return `node-dht-sensor could not access the GPIO hardware. The iobroker user needs to be in the gpio group. ${this.setupHint(
                sensor,
            )}`;
        }
        if (/did not answer/.test(message)) {
            return 'The read never finished, please report this together with a debug log.';
        }
        return 'Check wiring, power (use 3.3V), pull-up resistor and the configured sensor type.';
    }

    /**
     * @param [sensor] {object}
     * @returns {string} how to get DHT sensors working on this board
     */
    setupHint(sensor) {
        const pin = sensor ? sensor.gpio : '<gpio>';
        const kernel = `add "dtoverlay=dht11,gpiopin=${pin}" to /boot/firmware/config.txt and reboot - the adapter then uses the kernel driver automatically`;
        if (this.isPi5OrNewer) {
            return `On a Raspberry Pi 5 either ${kernel}, or rebuild node-dht-sensor with libgpiod support (see the adapter README).`;
        }
        return `Alternatively ${kernel}.`;
    }

    /**
     * Stop polling.
     */
    unload() {
        for (const timer of this.timers) {
            this.adapter.clearInterval(timer);
        }
        this.timers = [];
    }
}

module.exports = {
    DhtControl,
    temperatureStateName,
    humidityStateName,
    // exported for tests
    binaryBackend,
    detectLibraryBuild,
    effectivePollInterval,
    findKernelDhtDevices,
    readKernelDht,
    FAILURES_BEFORE_ERROR,
    FAILURE_REMINDER_EVERY,
};

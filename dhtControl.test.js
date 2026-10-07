'use strict';

const { expect } = require('chai');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
    DhtControl,
    binaryBackend,
    detectLibraryBuild,
    effectivePollInterval,
    findKernelDhtDevices,
    readKernelDht,
    FAILURES_BEFORE_ERROR,
    FAILURE_REMINDER_EVERY,
} = require('./lib/dhtControl');

/**
 * Device tree `gpios` property: phandle, line, flags as big endian 32 bit cells.
 *
 * @param line {number}
 * @returns {Buffer}
 */
function gpiosCells(line) {
    const buf = Buffer.alloc(12);
    buf.writeUInt32BE(0x41, 0);
    buf.writeUInt32BE(line, 4);
    buf.writeUInt32BE(0, 8);
    return buf;
}

/** @returns {any} logger that records its entries */
function createLog() {
    /** @type {Array<{level: string, msg: string}>} */
    const entries = [];
    /** @type {any} */
    const log = {};
    for (const level of ['silly', 'debug', 'info', 'warn', 'error']) {
        log[level] = msg => entries.push({ level, msg });
    }
    log.entries = entries;
    log.at = level => entries.filter(e => e.level === level).map(e => e.msg);
    return log;
}

/** @returns {any} the parts of an adapter DhtControl uses */
function createAdapter() {
    /** @type {Record<string, {val: unknown, ack: boolean}>} */
    const states = {};
    /** @type {Array<{fn: () => void, ms: number}>} */
    const intervals = [];
    return {
        log: createLog(),
        states,
        intervals,
        cleared: [],
        delays: [],
        setInterval(fn, ms) {
            const handle = { fn, ms };
            intervals.push(handle);
            return handle;
        },
        clearInterval(handle) {
            this.cleared.push(handle);
        },
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: handle => clearTimeout(handle),
        async delay(ms) {
            this.delays.push(ms);
        },
        async setStateChangedAsync(id, val, ack) {
            states[id] = { val, ack };
        },
    };
}

async function waitIdle(control) {
    for (let i = 0; i < 400 && control.sensors.some(s => s.busy); i++) {
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

describe('dhtControl', () => {
    let tmp;

    beforeEach(async () => {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rpi2-dht-'));
    });

    afterEach(async () => {
        await fs.rm(tmp, { recursive: true, force: true });
    });

    async function writeFiles(dir, files) {
        await fs.mkdir(dir, { recursive: true });
        for (const [name, content] of Object.entries(files)) {
            await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
            await fs.writeFile(path.join(dir, name), content);
        }
        return dir;
    }

    describe('effectivePollInterval', () => {
        it('uses the default if nothing is configured', () => {
            for (const configured of [0, '0', '', undefined, null, -5]) {
                expect(effectivePollInterval(configured, 22)).to.deep.equal({ interval: 30000, adjusted: 'default' });
            }
        });
        it('raises too short intervals to the datasheet minimum', () => {
            expect(effectivePollInterval(500, 22)).to.deep.equal({ interval: 2000, adjusted: 'raised' });
            expect(effectivePollInterval(500, 11)).to.deep.equal({ interval: 1000, adjusted: 'raised' });
        });
        it('keeps valid intervals, also when configured as string', () => {
            expect(effectivePollInterval('10000', 22)).to.deep.equal({ interval: 10000 });
            expect(effectivePollInterval(1500, 11)).to.deep.equal({ interval: 1500 });
        });
    });

    describe('binaryBackend', () => {
        it('detects the build variant of node-dht-sensor', () => {
            expect(binaryBackend(Buffer.from('\0libgpiod.so.3\0'))).to.equal('libgpiod');
            expect(binaryBackend(Buffer.from('\0bcm2835_init\0'))).to.equal('bcm2835');
            expect(binaryBackend(Buffer.from('nothing to see'))).to.equal('unknown');
        });
    });

    describe('detectLibraryBuild', () => {
        it('reads version and backend of the installed module', async () => {
            const root = await writeFiles(path.join(tmp, 'node-dht-sensor'), {
                'package.json': JSON.stringify({ version: '0.5.4' }),
                'build/Release/node_dht_sensor.node': Buffer.from('ELF...bcm2835_init...'),
            });
            const info = await detectLibraryBuild(() => path.join(root, 'package.json'));
            expect(info).to.deep.equal({ version: '0.5.4', backend: 'bcm2835' });
        });
        it('reports a missing binary instead of throwing', async () => {
            const root = await writeFiles(path.join(tmp, 'node-dht-sensor'), {
                'package.json': JSON.stringify({ version: '0.5.4' }),
            });
            const info = await detectLibraryBuild(() => path.join(root, 'package.json'));
            expect(info.version).to.equal('0.5.4');
            expect(info.backend).to.equal('unknown');
            expect(info.error).to.contain('ENOENT');
        });
    });

    describe('findKernelDhtDevices', () => {
        it('maps kernel dht11 devices to their GPIO', async () => {
            const iio = path.join(tmp, 'iio');
            // gpios property wins over the node name
            await writeFiles(path.join(iio, 'iio:device0'), { name: 'dht11@11\n', 'of_node/gpios': gpiosCells(17) });
            // overlay loaded without gpiopin=: node is still called dht11@0 but sits on GPIO 4
            await writeFiles(path.join(iio, 'iio:device1'), { name: 'dht11@0\n', 'of_node/gpios': gpiosCells(4) });
            // no gpios property: unit address in the name
            await writeFiles(path.join(iio, 'iio:device2'), { name: 'dht11@1a\n' });
            // not a dht sensor
            await writeFiles(path.join(iio, 'iio:device3'), { name: 'mcp3008\n', 'of_node/gpios': gpiosCells(9) });
            // unusual name, but compatible string and gpios on the parent device
            await writeFiles(path.join(iio, 'iio:device4'), {
                name: 'humidity\n',
                'device/of_node/compatible': 'vendor,thing\0dht11\0',
                'device/of_node/gpios': gpiosCells(5),
            });
            // dht11 without any hint which pin it uses
            await writeFiles(path.join(iio, 'iio:device5'), { name: 'dht11\n' });
            // /sys/bus/iio/devices entries are links into the platform device of the node
            const real = await writeFiles(path.join(tmp, 'platform', 'dht11@16', 'iio:device6'), { name: 'dht11\n' });
            await fs.symlink(real, path.join(iio, 'iio:device6'));

            const log = createLog();
            const { byGpio, unmapped } = await findKernelDhtDevices(iio, log);

            expect([...byGpio.entries()].sort((a, b) => a[0] - b[0])).to.deep.equal([
                [4, path.join(iio, 'iio:device1')],
                [5, path.join(iio, 'iio:device4')],
                [17, path.join(iio, 'iio:device0')],
                [22, path.join(iio, 'iio:device6')],
                [26, path.join(iio, 'iio:device2')],
            ]);
            expect(unmapped.map(u => u.dir)).to.deep.equal([path.join(iio, 'iio:device5')]);
            // the details for the bug report contain what was looked at
            expect(unmapped[0].details.join(' ')).to.contain('name="dht11"');
            // and the debug log shows the raw property, so a user log tells us the real layout
            expect(log.at('debug').join('\n')).to.contain('of_node/gpios=<00000041 00000011 00000000>');
        });

        it('copes with a system without iio devices', async () => {
            const { byGpio, unmapped } = await findKernelDhtDevices(path.join(tmp, 'missing'), createLog());
            expect(byGpio.size).to.equal(0);
            expect(unmapped).to.deep.equal([]);
        });
    });

    describe('readKernelDht', () => {
        it('converts milli units', async () => {
            const dir = await writeFiles(path.join(tmp, 'dev'), {
                in_temp_input: '-5300\n',
                in_humidityrelative_input: '45650\n',
            });
            expect(await readKernelDht(dir)).to.deep.equal({ temperature: -5.3, humidity: 45.7 });
        });
        it('rejects garbage', async () => {
            const dir = await writeFiles(path.join(tmp, 'dev'), {
                in_temp_input: 'oops\n',
                in_humidityrelative_input: '45650\n',
            });
            await readKernelDht(dir).should.be.rejectedWith('unexpected content');
        });
    });

    describe('DhtControl', () => {
        let adapter;
        let iio;
        let modelFile;

        beforeEach(async () => {
            adapter = createAdapter();
            iio = path.join(tmp, 'iio');
            await fs.mkdir(iio);
            modelFile = path.join(tmp, 'model');
            await fs.writeFile(modelFile, 'Raspberry Pi 4 Model B Rev 1.5\0');
        });

        function create(options = {}) {
            return new DhtControl(adapter, {
                iioRoot: iio,
                modelFile,
                detectLibrary: async () => ({ version: '0.5.4', backend: 'bcm2835' }),
                loadLibrary: () => ({ read: (type, gpio, cb) => cb(null, 21.5, 40.1) }),
                ...options,
            });
        }

        it('prefers the kernel driver and does not need node-dht-sensor for it', async () => {
            await writeFiles(path.join(iio, 'iio:device0'), {
                name: 'dht11@11\n',
                'of_node/gpios': gpiosCells(17),
                in_temp_input: '23400\n',
                in_humidityrelative_input: '45600\n',
            });
            let loaded = false;
            const control = create({
                loadLibrary: () => {
                    loaded = true;
                },
            });
            await control.setup([{ gpio: 17, configuration: 'dht22', debounceOrPoll: 10000 }]);
            await waitIdle(control);

            expect(loaded).to.equal(false);
            expect(adapter.intervals.map(i => i.ms)).to.deep.equal([10000]);
            expect(adapter.states).to.deep.equal({
                'gpio.17.temperature': { val: 23.4, ack: true },
                'gpio.17.humidity': { val: 45.6, ack: true },
            });
            const info = adapter.log.at('info').join('\n');
            expect(info).to.contain('kernel dht11 driver on GPIO 17');
            expect(info).to.contain('reading through the dht11 kernel driver');
            expect(info).to.contain('first reading 23.4°C, 45.6%');
            expect(adapter.log.at('error')).to.deep.equal([]);
        });

        it('retries kernel reads before counting a failure', async () => {
            // no in_temp_input: every read fails
            await writeFiles(path.join(iio, 'iio:device0'), { name: 'dht11@11\n', 'of_node/gpios': gpiosCells(17) });
            const control = create();
            await control.setup([{ gpio: 17, configuration: 'dht22', debounceOrPoll: 10000 }]);
            await waitIdle(control);

            expect(adapter.delays).to.deep.equal([2100, 2100]);
            expect(control.sensors[0].failures).to.equal(1);
            expect(adapter.log.at('debug').filter(m => m.includes('kernel read attempt'))).to.have.length(3);
        });

        it('reads through node-dht-sensor with numeric type and pin', async () => {
            const calls = [];
            const control = create({
                loadLibrary: () => ({
                    read: (type, gpio, cb) => {
                        calls.push([type, gpio]);
                        cb(null, 21.5, 40.1);
                    },
                }),
            });
            await control.setup([{ gpio: '4', configuration: 'dht11', debounceOrPoll: 0 }]);
            await waitIdle(control);

            expect(calls).to.deep.equal([[11, 4]]);
            expect(adapter.intervals.map(i => i.ms)).to.deep.equal([30000]);
            expect(adapter.states['gpio.4.temperature']).to.deep.equal({ val: 21.5, ack: true });
            expect(adapter.log.at('info').join('\n')).to.contain('no poll interval configured, using 30000ms');
        });

        it('polls every sensor on its own timer and only reads that sensor', async () => {
            const calls = [];
            const control = create({
                loadLibrary: () => ({
                    read: (type, gpio, cb) => {
                        calls.push(gpio);
                        cb(null, 20, 50);
                    },
                }),
            });
            await control.setup([
                { gpio: 4, configuration: 'dht22', debounceOrPoll: 5000 },
                { gpio: 5, configuration: 'dht22', debounceOrPoll: 7000 },
            ]);
            await waitIdle(control);
            calls.length = 0;

            adapter.intervals[1].fn();
            await waitIdle(control);
            expect(calls).to.deep.equal([5]);
            expect(adapter.intervals.map(i => i.ms)).to.deep.equal([5000, 7000]);
        });

        it('explains on a Pi 5 that the bcm2835 build cannot work', async () => {
            await fs.writeFile(modelFile, 'Raspberry Pi 5 Model B Rev 1.0\0');
            const control = create();
            await control.setup([{ gpio: 17, configuration: 'dht22', debounceOrPoll: 10000 }]);
            await waitIdle(control);

            const errors = adapter.log.at('error').join('\n');
            expect(errors).to.contain('Raspberry Pi 5 does not have');
            expect(errors).to.contain('dtoverlay=dht11,gpiopin=17');
        });

        it('does not start a sensor if node-dht-sensor cannot be loaded', async () => {
            const control = create({
                loadLibrary: () => {
                    throw new Error('Cannot find module node_dht_sensor.node');
                },
            });
            await control.setup([{ gpio: 4, configuration: 'dht22', debounceOrPoll: 10000 }]);

            expect(adapter.intervals).to.deep.equal([]);
            const errors = adapter.log.at('error').join('\n');
            expect(errors).to.contain('Cannot load node-dht-sensor: Cannot find module node_dht_sensor.node');
            expect(errors).to.contain('GPIO 4: not read');
        });

        it('warns about a kernel driver on a pin that is not configured', async () => {
            await writeFiles(path.join(iio, 'iio:device0'), { name: 'dht11@11\n', 'of_node/gpios': gpiosCells(17) });
            const control = create();
            await control.setup([{ gpio: 4, configuration: 'dht22', debounceOrPoll: 10000 }]);
            await waitIdle(control);

            expect(adapter.log.at('warn').join('\n')).to.contain('active on GPIO 17, but GPIO 17 is not configured');
        });

        it('logs unmappable kernel devices with details for a bug report', async () => {
            await writeFiles(path.join(iio, 'iio:device0'), { name: 'dht11\n' });
            const control = create();
            await control.setup([{ gpio: 4, configuration: 'dht22', debounceOrPoll: 10000 }]);
            await waitIdle(control);

            expect(adapter.log.at('warn').join('\n')).to.match(/could not tell which GPIO.*name="dht11"/);
        });

        it('treats implausible values as failure', async () => {
            const control = create({ loadLibrary: () => ({ read: (type, gpio, cb) => cb(null, 20, 120) }) });
            await control.setup([{ gpio: 4, configuration: 'dht22', debounceOrPoll: 10000 }]);
            await waitIdle(control);

            expect(adapter.states).to.deep.equal({});
            expect(control.sensors[0].failures).to.equal(1);
            expect(adapter.log.at('debug').join('\n')).to.contain('implausible values: 20°C, 120%');
        });

        it('skips a poll while the previous read is still running', async () => {
            /** @type {any} */
            let pending;
            const control = create({ loadLibrary: () => ({ read: (type, gpio, cb) => (pending = cb) }) });
            await control.setup([{ gpio: 4, configuration: 'dht22', debounceOrPoll: 10000 }]);

            await control.poll(control.sensors[0]);
            expect(adapter.log.at('debug').join('\n')).to.contain('previous read still running');
            pending(null, 20, 50);
            await waitIdle(control);
        });

        it('logs failures quietly first, then as error, then as periodic reminder', async () => {
            const control = create();
            await control.setup([{ gpio: 4, configuration: 'dht22', debounceOrPoll: 10000 }]);
            await waitIdle(control);
            const sensor = control.sensors[0];
            adapter.log.entries.length = 0;

            for (let i = 1; i < FAILURES_BEFORE_ERROR; i++) {
                control.recordFailure(sensor, new Error('failed to read sensor'));
            }
            expect(adapter.log.at('error')).to.deep.equal([]);

            control.recordFailure(sensor, new Error('failed to read sensor'));
            const errors = adapter.log.at('error');
            expect(errors).to.have.length(1);
            expect(errors[0]).to.contain('failed to read sensor');
            expect(errors[0]).to.contain('It worked before.');
            expect(errors[0]).to.contain('node-dht-sensor 0.5.4 (bcm2835 build)');

            while (sensor.failures < FAILURE_REMINDER_EVERY) {
                control.recordFailure(sensor, new Error('failed to read sensor'));
            }
            expect(adapter.log.at('error')).to.have.length(1);
            expect(adapter.log.at('warn')).to.deep.equal([
                `DHT22 sensor on GPIO 4: still failing, ${FAILURE_REMINDER_EVERY} reads in a row. Last error: failed to read sensor`,
            ]);

            await control.recordSuccess(sensor, 20, 50);
            expect(adapter.log.at('info').join('\n')).to.contain(
                `works again after ${FAILURE_REMINDER_EVERY} failed attempts`,
            );
            expect(sensor.failures).to.equal(0);
        });

        it('stops its timers on unload', async () => {
            const control = create();
            await control.setup([{ gpio: 4, configuration: 'dht22', debounceOrPoll: 10000 }]);
            await waitIdle(control);
            control.unload();
            expect(adapter.cleared).to.deep.equal(adapter.intervals);
        });
    });
});

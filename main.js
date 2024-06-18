/**
 *      RPI-Monitor Adapter
 *
 *      License: MIT
 */
'use strict';

/*
 * Created with @iobroker/create-adapter v2.6.3
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const parsers = require('./lib/parsers');
const {buttonEvents, GpioControl} = require('./lib/gpioControl');

const errorsLogged = {};
const intervalTimers = [];

class Rpi2 extends utils.Adapter {

    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: 'rpi2',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on('objectChange', this.onObjectChange.bind(this));
        // this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        objects = {};

        //sanitize timeouts:
        this.config.inputDebounceMs = Math.min(Number(this.config.inputDebounceMs) || 30, 10000);

        const adapterObjects = await this.getAdapterObjectsAsync();
        if (this.config.forceinit) {
            for (const id of Object.keys(adapterObjects)) {
                if (/^rpi2\.\d+$/.test(id)) {
                    this.log.debug('Skip root object ' + id);
                    continue;
                }

                this.log.debug('Remove ' + id + ': ' + id);
                try {
                    await this.delObjectAsync(id);
                    await this.deleteStateAsync(id);
                } catch (err) {
                    this.log.error('Could not delete ' + id + ': ' + err);
                }
            }
        } else {
            for (const id of Object.keys(adapterObjects)) {
                objects[id] = true; //object already exists.
            }
            this.log.debug('received all objects');
        }
        this.gpioControl = new GpioControl(this, this.log);
        await this.subscribeStatesAsync('*');
        await main(this);
        await this.initPorts();
    }

    async initPorts() {
        if (this.config.gpios && this.config.gpios.length) {
            const gpioPorts = [];
            const buttonPorts = [];
            const dhtPorts = [];

            for (let port = 0; port < this.config.gpios.length; port++) {
                if (this.config.gpios[port]) {
                    /* Ensure backwards compatibility of property .input
                    * in older versions, it was true for "in" and false for "out"
                    * in newer versions, it is "in", "out", "outlow" or "outhigh"
                    * Do this now, so we only have to check for newer versions everywhere else.
                    */
                    if (this.config.gpios[port].input === 'true' || this.config.gpios[port].input === true) {
                        this.config.gpios[port].input = 'in';
                    }
                    else if (this.config.gpios[port].input === 'false' || this.config.gpios[port].input === false) {
                        this.config.gpios[port].input = 'out';
                    }
                }

                // syncPort sets up the object tree.
                // Do it now so all ready when
                // physical GPIOs are enabled below.
                await this.syncPort(port, this.config.gpios[port] || {});

                if (this.config.gpios[port] && this.config.gpios[port].enabled) {

                    // Push port numbers into arrays as required for the setup below.
                    switch (this.config.gpios[port].input) {
                        case 'in':
                        case 'out':
                        case 'outlow':
                        case 'outhigh':
                            gpioPorts.push(port);
                            break;
                        case 'button':
                            buttonPorts.push(port);
                            break;
                        case 'dht11':
                        case 'dht22':
                            dhtPorts.push(port);
                            break;
                        default:
                            this.log.error('Cannot setup port ' + port + ': invalid direction type.');
                    }
                }
            }

            await this.gpioControl.setupGpio(gpioPorts, buttonPorts);
            setupDht(this, dhtPorts);
        } else {
            this.log.info('GPIO ports are not configured');
        }
    }

    /**
     * Create ioBroker Objects for gpio port.
     * @param port {number}
     * @param data {object} from config.
     * @returns {Promise<void>}
     */
    async syncPort(port, data) {
        data.isGpio = (data.input === 'in' || data.input === 'out' || data.input === 'outlow' || data.input === 'outhigh');
        data.isButton = (data.input === 'button');
        data.isTempHum = (data.input === 'dht11' || data.input === 'dht22');
        data.isInput = (data.input === 'in' || data.isButton || data.isTempHum);

        const channelName = 'gpio.' + port;
        if (data.enabled) {
            await this.extendObjectAsync(channelName, {
                type: 'channel',
                common: {
                    name: data.label === '' ? 'GPIO ' + port : data.label,
                    // TODO: should we do more than just add this as 'info'?
                    role: 'info'
                }
            });
        }

        const stateName = 'gpio.' + port + '.state';
        if (data.enabled && data.isGpio) {
            const obj = {
                common: {
                    name:  'GPIO ' + port,
                    type:  'boolean',
                    role:  data.isInput ? 'indicator' : 'switch',
                    read:  data.isInput,
                    write: !data.isInput
                },
                native: {
                },
                type: 'state'
            };
            // extendObject creates one if it doesn't exist - the same below
            await this.extendObjectAsync(stateName, obj);
        } else {
            await this.delObjectAsync(stateName);
        }
        await this.syncPortDirection(port, data);
        await this.syncPortButton(port, data);
        await this.syncPortTempHum(port, data);

        if (!data.enabled) {
            await this.delObjectAsync(channelName, {recursive: true});
        }
    }

    /**
     * Create/Delect Object for GPIO button
     * @param port {number}
     * @param data {object} from config
     * @returns {Promise<void>}
     */
    async syncPortButton(port, data) {
        const buttonEventsOLD = [ 'pressed', 'clicked', 'clicked_pressed', 'double_clicked', 'released' ];
        for (const eventName of buttonEventsOLD) {
            const stateName = `gpio.${port}.${eventName}`;
            await this.delObjectAsync(stateName);
        }
        for (const eventName of buttonEvents) {
            const stateName = `gpio.${port}.${eventName}`;
            if (data.enabled && data.isButton) {
                const obj = {
                    common: {
                        name:  'GPIO ' + port + ' ' + eventName,
                        type:  'boolean',
                        role:  'button',
                        read:  false,
                        write: true
                    },
                    native: {
                    },
                    type: 'state'
                };
                await this.extendObjectAsync(stateName, obj);
            } else {
                //await this.delObjectAsync(stateName);
                //Do not delete 'state' as this is used above. TODO: clean up code, when decided if buttons are ever supported.
            }
        }
    }

    /**
     * Create/Delete ioBroker Objects for gpio temperature and humidity.
     * @param port {number}
     * @param data {object} from config
     * @returns {Promise<void>}
     */
    async syncPortTempHum(port, data) {
        if (data.enabled && data.isTempHum) {
            const obj = {
                common: {
                    name:  'GPIO ' + port + ' temperature',
                    type:  'number',
                    role:  'value.temperature',
                    read:  true,
                    write: false
                },
                native: {
                },
                type: 'state'
            };
            await this.extendObjectAsync(temperatureStateName(port), obj);
        } else {
            await this.delObjectAsync(temperatureStateName(port));
        }
        if (data.enabled && data.isTempHum) {
            const obj = {
                common: {
                    name:  'GPIO ' + port + ' temperature',
                    type:  'number',
                    role:  'value.humidity',
                    read:  true,
                    write: false
                },
                native: {
                },
                type: 'state'
            };
            await this.extendObjectAsync(humidityStateName(port), obj);
        } else {
            await this.delObjectAsync(humidityStateName(port));
        }
    }

    /**
     * Create ioBroker Objects for gpio button.
     * @param port
     * @param data
     * @returns {Promise<void>}
     */
    async syncPortDirection(port, data) {
        const stateName = 'gpio.' + port + '.isInput';
        if (data.enabled) {
            this.log.debug(`Creating ${stateName}`);
            const obj = {
                common: {
                    name:  'GPIO ' + port + ' direction',
                    type:  'boolean',
                    role:  'state',
                    read:  true,
                    write: false
                },
                native: {
                },
                type: 'state'
            };
            await this.extendObjectAsync(stateName, obj);
            await this.setStateAsync(stateName, data.isInput, true);
        } else {
            await this.delObjectAsync(stateName);
        }
    }

    onStateChange(id, state) {
        if (state && !state.ack) {
            this.log.debug('stateChange for ' + id + ' found state = ' + JSON.stringify(state));
            if (id.indexOf('gpio.') !== -1) {
                const parts = id.split('.');
                parts.pop(); // remove state
                this.gpioControl.writeGpio(parts.pop(), state.val);
            }
        }
    }

    async onUnload(callback) {
        try {
            // Cancel any intervals
            for (const interval of intervalTimers) {
                clearInterval(interval);
            }
            await this.gpioControl.unload();
            callback();
        } catch (e) {
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new Rpi2(options);
} else {
    // otherwise start the instance directly
    new Rpi2();
}

let objects;
let exec;
const rpi      = {};
const table    = {};

async function main(adapter) {
    if (anyParserConfigEnabled(adapter)) {
        // TODO: Check which Objects we provide
        intervalTimers.push(setInterval(() => {parser(adapter);}, adapter.config.interval || 60000));

        exec = require('child_process').execSync;
        await parser(adapter);
    } else {
        adapter.log.info('No parser items enabled - skipping');
        for (const c of Object.keys(parsers)) {
            adapter.log.debug('Cleaning up ' + c);
            await adapter.delObjectAsync(adapter.name + '.' + adapter.instance + '.' + c, {recursive: true});
        }
    }
}

function anyParserConfigEnabled(adapter) {
    for (const parserKey of Object.keys(parsers)) {
        if (adapter.config['c_' + parserKey] === true) {
            adapter.log.debug(`${parserKey} is enabled`);
            return true;
        }
    }
    return false;
}

async function parser(adapter) {
    adapter.log.debug('start parsing');

    // Workaround, WebStorm
    const config = adapter.config;
    for (const c of Object.keys(parsers)) {
        adapter.log.debug('PARSING: ' + c);

        if (config['c_' + c] === true) {
            table[c] = new Array(20);
            const o = parsers[c];
            for (const i of Object.keys(o)) {
                adapter.log.debug('    PARSING: ' + i);
                const object = o[i];
                const command = object.command;
                let regexp;
                if (object.multiline !== undefined) {
                    regexp = new RegExp(object.regexp, 'm');
                } else {
                    regexp = new RegExp(object.regexp);
                }
                const post = object.post;

                adapter.log.debug('---> ' + command);

                let stdout;
                try {
                    stdout = exec(command).toString();
                    adapter.log.debug('------------- ' + stdout);
                } catch (er) {
                    adapter.log.debug(er.stack);
                    if (er.pid) console.log('%s (pid: %d) exited with status %d',
                        er.file, er.pid, er.status);
                    // do not process if exec fails
                    continue;
                }

                const match = regexp.exec(stdout);
                adapter.log.debug('---> REGEXP: ' + regexp);
                if (match !== undefined && match !== null && match.length !== undefined) {
                    adapter.log.debug('GROUPS: ' + match.length);
                }
                // TODO: if Group Match is bigger than 2
                // split groups and header into separate objects
                if (match !== undefined && match !== null && match.length > 2) {
                    const lname = i.split(',');
                    for (let m = 1; m < match.length; m++) {
                        const value = match[m];
                        const name = lname[m - 1];
                        adapter.log.debug('MATCHING: ' + value);
                        adapter.log.debug('NAME: ' + name + ', VALULE: ' + value);

                        rpi[name] = value;
                        table[c][i] = value;
                    }
                } else {
                    adapter.log.debug('---> POST:   ' + post);
                    let value;
                    if (match !== undefined && match !== null) {
                        value = match[1];
                    } else {
                        value = stdout;
                    }
                    rpi[i] = value;
                    table[c][i] = value;
                }
            }
        }
    }

    // TODO: Parse twice to get post data and evaluate
    for (const c of Object.keys(parsers)) {
        adapter.log.debug('CURRENT = ' + c + ' ' + config['c_' + c]);
        adapter.log.debug(String(c.indexOf('c_')));
        if (config['c_' + c] === true)  {
            if (objects[c] === undefined) {
                const stateObj = {
                    common: {
                        name:   c, // You can add here some description
                        role:   'sensor'
                    },
                    type:   'device',
                    _id:    c
                };

                await adapter.extendObjectAsync(c, stateObj);
                objects[c] = true; //remember that we created the object.
            }
            const o = parsers[c];
            for (const i of Object.keys(o)) {
                const object = o[i];
                const post = object.post;

                adapter.log.debug('---> POST:   ' + post + ' for ' + i + ' in ' + o);
                let value;

                const lname = i.split(',');
                if (lname !== undefined && lname.length > 1) {
                    for (let m = 0; m < lname.length; m++) {
                        const name = lname[m];
                        value = rpi[name];

                        // TODO: Check if value is number and format it 2 Digits
                        if (!isNaN(value)) {
                            value = parseFloat(value);
                            const re = new RegExp(/^\d+\.\d+$/);
                            if (re.exec(value)) {
                                value = parseFloat(value.toFixed(2));
                            }
                        }

                        adapter.log.debug('MATCHING: ' + value);
                        adapter.log.debug('NAME: ' + name + ' VALUE: ' + value);

                        const objectName = adapter.name + '.' + adapter.instance + '.' + c + '.' + name;
                        adapter.log.debug('SETSTATE FOR ' + objectName + ' VALUE = ' + value);
                        if (objects[objectName] === undefined) {
                            // TODO Create an Object tree
                            const stateObj = {
                                common: {
                                    name:  objectName, // You can add here some description
                                    read:  true,
                                    write: false,
                                    state: 'state',
                                    role:  'value',
                                    type:  'number'
                                },
                                type: 'state'
                            };
                            await adapter.extendObjectAsync(objectName, stateObj);
                            objects[objectName] = true; //remember that we created the object.
                        }
                        await adapter.setStateAsync(objectName, {
                            val: value,
                            ack: true
                        });
                    }
                } else {
                    value = rpi[i];
                    if (value !== undefined && value !== '' && value !== null) {
                        if (post.indexOf('$1') !== -1) {
                            adapter.log.debug('VALUE: ' + value + ' POST: ' + post);
                            try {
                                value = eval(post.replace('$1', value));
                            } catch (e) {
                                adapter.log.error('Cannot evaluate: ' + post.replace('$1', value));
                                value = NaN;
                            }
                        }
                        // TODO: Check if value is number and format it 2 Digits
                        if (!isNaN(value)) {
                            value = parseFloat(value);
                            const r = new RegExp(/^\d+\.\d+$/);
                            if (r.exec(value)) {
                                value = parseFloat(value.toFixed(2));
                            }
                        }

                        const objectName = adapter.name + '.' + adapter.instance + '.' + c + '.' + i;
                        adapter.log.debug('SETSTATE FOR ' + objectName + ' VALUE = ' + value);
                        if (objects[objectName] === undefined) {
                            // TODO Create an Objecttree
                            const stateObj = {
                                common: {
                                    name:  objectName, // You can add here some description
                                    read:  true,
                                    write: false,
                                    state: 'state',
                                    role:  'value',
                                    type:  'mixed'
                                },
                                type: 'state'
                            };
                            await adapter.extendObjectAsync(objectName, stateObj);
                            objects[objectName] = true; //remember that we created the object.
                        }
                        await adapter.setStateAsync(objectName, {
                            val: value,
                            ack: true
                        });
                    } else {
                        if (i === 'wifi_send' || i === 'wifi_received') {
                            adapter.log.debug('No Value found for ' + i);
                        } else if (! errorsLogged[i]) {
                            adapter.log.error('No Value found for ' + i);
                            errorsLogged[i] = true;
                        }
                    }
                }
            }
        } else if (c.indexOf('c_') !== 0 && config['c_' + c] === false) {
            //is config, but disabled.
            const folderId = `${adapter.namespace}.${c}`;
            adapter.log.debug(`${c} disabled -> clean up.`);
            if (objects[folderId]) { //if object exists, delete it.
                await adapter.delObjectAsync(folderId, {recursive: true});
                delete objects[folderId];
                for (const id of Object.keys(objects)) {
                    if (id.startsWith(folderId)) {
                        delete objects[id];
                    }
                }
            }
        }
    }
}

function temperatureStateName(port) {
    return `gpio.${port}.temperature`;
}
function humidityStateName(port) {
    return `gpio.${port}.humidity`;
}

// Setup DHTxx/AM23xx sensors
function setupDht(adapter, dhtPorts) {
    if (dhtPorts.length === 0) return;
    const pollInterval = adapter.config.dhtPollInterval;
    if (pollInterval === 0) {
        adapter.log.warn('DHTxx/AM23xx configured but polling disabled');
    } else if (pollInterval < 350) {
        adapter.log.error(`DHTxx/AM23xx polling interval seems too short (${pollInterval}) - disabling`);
    } else {
        // Config is good
        const sensorLib = require('node-dht-sensor');

        // Initialise ports, keeping track of those that worked with type
        const dhtInitd = [];
        for (const port of dhtPorts) {
            const type = adapter.config.gpios[port].input === 'dht11' ? 11 : 22;
            try {
                sensorLib.initialize(type, port);
                dhtInitd[port] = [type];
            } catch (err) {
                adapter.log.error(`Failed to initialise DHTxx/AM23xx: ${type}/${port}`);
            }
        }

        if (dhtInitd.length > 0) {
            // At least one initialized, set polling on the configured interval
            intervalTimers.push(setInterval(async () => {
                for (const [port, type] of Object.entries(dhtInitd)) {
                    sensorLib.read(type, port, async function(err, temperature, humidity) {
                        if (err) {
                            adapter.log.error(`Failed to read DHTxx/AM23xx: ${type}/${port}`);
                        } else {
                            adapter.log.debug(`Read DHTxx/AM23xx: ${type}/${port} : ${temperature}°C, humidity: ${humidity}%`);
                            await adapter.setStateChanged(temperatureStateName(port), temperature, true);
                            await adapter.setStateChanged(humidityStateName(port), humidity, true);
                        }
                    });
                }
            }, pollInterval));
        }
    }
}

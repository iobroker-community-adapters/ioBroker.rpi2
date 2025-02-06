// Which button events will we capture and have states for?
// See https://www.npmjs.com/package/rpi-gpio-buttons
//const buttonEvents = [ 'pressed', 'clicked', 'clicked_pressed', 'double_clicked', 'released' ];
const buttonEvents = [ 'state' ];

const util = require('util');
const exec = util.promisify(require('node:child_process').exec);

function getRaspberryModelFromCpuInfo(cpuinfo) {
    //Zero reports: Raspberry Pi Zero 2 W Rev 1.0
    // RPi Zero family has a different naming.
    // All Rpi Zero share the same ChipNum as RPi 1 and thus can all be handled as a Rpi 1.
    if (cpuinfo.includes('Zero')) {
        return 1;
    }

    const modelRegEx = /^Raspberry Pi (\d+) Model.*/mi;
    const results = modelRegEx.exec(cpuinfo);
    const model = results ? results[1] : 1;
    return Number(model);
}

class GpioControl {
    constructor(adapter, log) {
        this.adapter = adapter;
        this.gpioChip = null;
        //this.gpioButtons = null;
        this.log = log;
        this.gpioPorts = [];
        this.gpioSettings = [];
        this.gpioPortLastWrite = [];
        this.gpioInputPorts = [];
        this.gpioOutputPorts = [];
        this.gpioInputPortsHandler = null;
    }

    /**
     * Setup GPIO ports & buttons
     * @param gpioPorts {Array<Object>}
     * @param buttonPorts {Array<Object>}
     * @returns undefined
     */
    async setupGpio(gpioPorts, buttonPorts) {
        if (gpioPorts.length === 0 && buttonPorts.length === 0) {
            return;
        }

        try {

            const { Default, Edge } = require('opengpio');
            //mock... maybe move that to test library in future.
            //const Default = { watch: () => { return {value: false, on: () => {}} }, output: () => { return {value: false}}};
            //const Edge = { Both: 1};

            let chipNum = 0;
            try {
                this.log.debug(Default);

                const {stdout, stderr} = await exec('cat /proc/device-tree/model');
                this.log.debug('CPU Info: ' + stdout);
                this.log.debug('STDERR: ' + stderr);
                const model = getRaspberryModelFromCpuInfo(stdout);
                this.log.debug(`Got ${model} from ${stdout}.`);
                if (model >= 5) {
                    this.log.debug('Using GPIO chip 4 for Raspberry Pi 5 or newer.');
                    chipNum = 4;
                }
                this.gpioChip = true; //let's keep this condition for now.
            } catch (e) {
                this.log.error('Cannot read CPU Info: ' + e);
            }

            this.gpioChip = Default;
            if (this.gpioChip === undefined) {
                this.log.warn('Cannot initialize GPIO: No chip found. GPIO functionality disabled!');
                this.log.warn('Please make sure that libgpiod-dev (on raspian/debian run sudo apt install libgpiod-dev) is installed in the system and then reinstall the adapter.');
                this.log.warn('If the library is installed and npm list | grep opengpio shows the npm library is also installed, please report this issue to the adapter developer with the model of your device and deboug output from an adapter start.');
            }
            this.log.debug('Got chip: ' + this.gpioChip);
            //this.log.debug(`GPIO chip ${JSON.stringify(this.gpioChip?.info)} initialized`);

            if (this.gpioChip) {
                // Setup all the regular GPIO input and outputs.
                for (const gpioSetting of gpioPorts) {
                    const direction = gpioSetting.configuration;
                    this.log.debug(`Port ${gpioSetting.gpio} direction: ${direction}`);

                    //TODO: currently pull-up / pull-down is not supported by the library.
                    //sanitize timeouts:
                    gpioSetting.debounceOrPoll = Math.min(Number(gpioSetting.debounceOrPoll) || 0, 10000);
                    this.gpioSettings[gpioSetting.gpio] = gpioSetting; //keep settings for later.
                    if (direction === 'in') {
                        const watch = this.gpioChip.watch({chip: chipNum, line: gpioSetting.gpio}, Edge.Both);
                        this.gpioPorts[gpioSetting.gpio] = watch;
                        this.gpioInputPorts.push(gpioSetting.gpio);
                        await this.readValue(gpioSetting.gpio);
                    } else {
                        const pin = this.gpioChip.output({chip: chipNum, line: gpioSetting.gpio});
                        this.gpioPorts[gpioSetting.gpio] = pin;
                        this.gpioOutputPorts.push(gpioSetting.gpio);
                    }
                }
                for (const gpioSetting of buttonPorts) {
                    //still the same as input ports...
                    this.gpioSettings[gpioSetting.gpio] = gpioSetting; //keep settings for later.
                    const watch = this.gpioChip.watch({chip: chipNum, line: gpioSetting.gpio}, Edge.Both);
                    this.gpioPorts[gpioSetting.gpio] = watch;
                    this.gpioInputPorts.push(gpioSetting.gpio);
                    await this.readValue(gpioSetting.gpio);
                }

                for (const port of this.gpioInputPorts) {
                    this.log.debug(`Adding event listener for port ${port}`);
                    const watch = this.gpioPorts[port];
                    watch.on('change', async (value) => {
                        this.log.debug('GPIO change on port ' + port + ': ' + value);
                        if (this.gpioPortLastWrite[port] === undefined) {
                            this.gpioPortLastWrite[port] = 0;
                        }
                        if (Date.now() - this.gpioPortLastWrite[port] < this.gpioSettings[port].debounceOrPoll) {
                            this.log.debug(`Ignoring change event due to debounce: ${(Date.now() - this.gpioPortLastWrite[port])}ms < ${this.gpioSettings[port].debounceOrPoll}.`);
                            return;
                        }
                        await this.readValue(port, value);
                    });
                }

                //write initial values to output ports - do people want that?:
                for (const port of this.gpioOutputPorts) {
                    await this.writeGpio(port);
                }

                // Setup any buttons using the same rpi-gpio object as other I/O.
                if (buttonPorts.length > 0) {
                    this.log.error('Button ports not yet supported... not sure if they ever will be - please discuss in github: https://github.com/iobroker-community-adapters/ioBroker.rpi2/issues/192 - if cannot make an account and have something constructive and new to add, contact Garfonso.');
                    /*this.log.debug(`Setting up button ports: ${buttonPorts}`);
                    try {
                        const rpi_gpio_buttons = require('rpi-gpio-buttons');
                        this.gpioButtons = new rpi_gpio_buttons({
                            pins: buttonPorts,
                            usePullUp: this.config.buttonPullUp,
                            timing: {
                                debounce: this.config.buttonDebounceMs,
                                pressed: this.config.buttonPressMs,
                                clicked: this.config.buttonDoubleMs
                            },
                            gpio: this.gpio
                        });
                    } catch (e) {
                        this.gpioButtons = null;
                        this.log.error('Cannot initialize GPIO Buttons: ' + e);
                        console.error(e);
                        if (e.message.includes('NODE_MODULE_VERSION')) {
                            return this.adapter.terminate('A dependency requires a rebuild.', 13);
                        }
                    }

                    // Setup events for buttons - only has to be done once no matter how many buttons we have.
                    if (this.gpioButtons) {
                        for (const eventName of buttonEvents) {
                            this.log.debug(`Register button handler for ${eventName}`);
                            this.gpioButtons.on(eventName, async (port) => {
                                this.log.debug(`${eventName} triggered for port ${port}`);
                                const stateName = `gpio.${port}.${eventName}`;
                                await this.adapter.setStateAsync(stateName, true, true);
                            });
                        }
                        // And start button processing
                        this.gpioButtons.init().catch(err => {
                            this.log.error(`An error occurred during buttons init(). ${err.message}`);
                        });
                    }*/
                }
            }
        } catch (e) {
            this.gpioChip = null;
            this.log.error('Cannot initialize/setMode GPIO: ' + e);
            this.log.error('Please make sure that libgpiod-dev (on raspian/debian run sudo apt install libgpiod-dev) is installed in the system and then reinstall the adapter.');
            console.error(e);
            if (e.message.includes('NODE_MODULE_VERSION')) {
                return this.adapter.terminate('A dependency requires a rebuild.', 13);
            }
        }
    }

    /**
     * Read the value of a GPIO port and update the corresponding state.
     * @param port {number}
     * @param [value] {boolean}
     * @returns Promise<void>
     */
    async readValue(port, value) {
        if (this.gpioPorts[port]) {
            try {
                if (typeof value === 'undefined') {
                    value = this.gpioPorts[port].value;
                }
                this.gpioPortLastWrite[port] = Date.now();
                value = this.gpioSettings[port].pullUp ? !value : value;
                this.log.debug(`Setting state for port ${port} to ${value}`);
                await this.adapter.setState('gpio.' + port + '.state', value, true);
            } catch (err) {
                this.log.error('Cannot read port ' + port + ': ' + err);
            }
        }
    }

    /**
     * Write a value to a GPIO port and update the corresponding state.
     * @param port {number|string}
     * @param [value] {boolean|string} - if not supplied, will be read from ioBroker state
     */
    async writeGpio(port, value) {
        if (value === undefined) {
            // set the value based on configuration or state.
            if (this.gpioSettings[port].configuration === 'outhigh') {
                value = true;
            } else if (this.gpioSettings[port].configuration === 'outlow') {
                value = false;
            } else {
                this.log.debug('Setting no initial value for port ' + port);
                return;
            }
            this.log.debug('Setting initial value for port ' + port + ' to ' + value);
        }

        if (typeof port === 'string') {
            port = parseInt(port, 10);
        }
        if (!this.gpioSettings[port]) {
            this.log.warn('Port ' + port + ' is not writable, because disabled.');
            return;
        } else if (!this.gpioSettings[port].configuration.startsWith('out')) {
            this.log.warn('Port ' + port + ' is configured as input and not writable');
            return;
        }

        if (value === 'true')  value = true;
        if (value === 'false') value = false;
        if (value === '0')     value = false;
        value = !!value;

        try {
            if (this.gpioPorts[port]) {
                try {
                    this.gpioPorts[port].value = value;
                    this.log.debug('Written ' + value + ' into port ' + port);
                    await this.adapter.setStateAsync('gpio.' + port + '.state', value, true);
                } catch (err) {
                    this.log.error('Cannot write port ' + port + ': ' + err);
                }
            } else {
                this.log.error('GPIO is not initialized!');
            }
        } catch (error) {
            this.log.error('Cannot write port ' + port + ': ' + error);
        }
    }

    /**
     * Cleanup on unload.
     * @returns {Promise<void>}
     */
    async unload() {
        // Cancel any debounceTimers
        if (this.gpioChip && this.gpioChip !== true && typeof this.gpioChip.close === 'function') {
            this.gpioChip.close();
        }
        for (const pin of this.gpioPorts) {
            if (pin) {
                try {
                    pin.stop();
                } catch (err) {
                    this.log.error(`Failed to release gpioLine: ${err}`);
                }
            }
        }
        this.adapter.clearInterval(this.gpioInputPortsHandler);
    }
}

exports.buttonEvents = buttonEvents;
exports.GpioControl = GpioControl;

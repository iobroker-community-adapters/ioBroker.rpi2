// Which button events will we capture and have states for?
// See https://www.npmjs.com/package/rpi-gpio-buttons
//const buttonEvents = [ 'pressed', 'clicked', 'clicked_pressed', 'double_clicked', 'released' ];
const buttonEvents = [ 'state' ];

const util = require('util');
const exec = util.promisify(require('node:child_process').exec);

function getRaspberryModelFromCpuInfo(cpuinfo) {
    const modelRegEx = /^Raspberry Pi (\d+) Model.*/mi;
    const model = modelRegEx.exec(cpuinfo)[1];
    return Number(model);
}

// not used.. classes are too overengineered... :-(
//function parseModelStringToClassName(modelString) {
//    const modelRegEx = /.*Raspberry Pi (\d+) Model B(\+?).*/mi;
//    const parts = modelRegEx.exec(modelString);
//    if (parts) {
//        //not sure about those other devices, like Nano whatever... they need to report. :-p
//        return `RaspberryPi_${parts[1]}B${parts[2] ? 'Plus' : ''}`;
//  }
//    return 'Default';
//}

class GpioControl {
    constructor(adapter, log) {
        this.adapter = adapter;
        this.gpioChip = null;
        //this.gpioButtons = null;
        this.config = adapter.config;
        this.log = log;
        this.gpioPorts = [];
        this.gpioPortLastWrite = [];
        this.gpioInputPorts = [];
        this.gpioOutputPorts = [];
        this.gpioInputPortsHandler = null;
    }

    /**
     * Setup GPIO ports & buttons
     * @param gpioPorts {number[]}
     * @param buttonPorts {number[]}
     * @returns undefined
     */
    async setupGpio(gpioPorts, buttonPorts) {
        if (gpioPorts.length === 0 && buttonPorts.length === 0) return;

        try {
            const { Default, Edge } = require('opengpio');
            let chipNum = null;
            try {
                this.log.debug(Default);

                const {stdout, stderr} = await exec('cat /proc/device-tree/model');
                this.log.debug('CPU Info: ' + stdout);
                this.log.debug('STDERR: ' + stderr);
                try {
                const model = getRaspberryModelFromCpuInfo(stdout);
                this.log.debug(`Got ${model} from ${stdout}.`);
                    if (model >= 5) {
                    this.log.debug('Using GPIO chip 4 for Raspberry Pi 5 or newer.');
                    chipNum = 4;
                    }
                    else {
                        chipNum = 0;
                        }
                }
                catch {
                if (stdout).includes("Zero"){
                    this.log.debug('Using GPIO chip 0 for Raspberry Zero family.');
                    chipNum = 0;
                }
                }
               this.gpioChip = true; //let's keep this condition for now. 
            } catch (e) {
                this.log.error('Cannot read CPU Info: ' + e);
               }
            

            //this.log.debug(Input);
            //this.log.debug(Output);

            this.log.debug('Inputs are pull ' + (this.config.inputPullUp ? 'up' : 'down') + '.');
            this.log.debug('Buttons are pull ' + (this.config.buttonPullUp ? 'up' : 'down') + '.');

            //this.gpioChip = openGpioChip(chipPath); -> somehow not necessary with this library?
            if (Default === undefined) {
                this.log.warn('Cannot initialize GPIO: No chip found. GPIO functionality disabled!');
                this.log.warn('Please make sure that libgpiod-dev (on raspian/debian run sudo apt install libgpiod-dev) is installed in the system and then reinstall the adapter.');
                this.log.warn('If the library is installed and npm list | grep opengpio shows the npm library is also installed, please report this issue to the adapter developer with the model of your device and deboug output from an adapter start.');
            }
            this.log.debug('Got chip: ' + Default);
            this.log.debug(`GPIO chip ${JSON.stringify(Default?.info)} initialized`);

            if (this.gpioChip) {
                // Setup all the regular GPIO input and outputs.
                for (const port of gpioPorts) {
                    const direction = this.config.gpios[port].input;
                    this.log.debug(`Port ${port} direction: ${direction}`);

                    //TODO: currently pull-up / pull-down is not supported by the library.
                    if (direction === 'in') {
                        const watch = Default.watch({chip: chipNum, line: port}, Edge.Both);
                        this.gpioPorts[port] = watch;
                        this.gpioInputPorts.push(port);
                        await this.readValue(port);
                    } else {
                        const pin = Default.output({chip: chipNum, line: port});
                        this.gpioPorts[port] = pin;
                        this.gpioOutputPorts.push(port);
                    }
                }
                for (const port of buttonPorts) {
                    //still the same as input ports...
                    const watch = Default.watch({chip: chipNum, line: port}, Edge.Both);
                    this.gpioPorts[port] = watch;
                    this.gpioInputPorts.push(port);
                    await this.readValue(port);
                }

                for (const port of this.gpioInputPorts) {
                    this.log.debug(`Adding event listener for port ${port}`);
                    const watch = this.gpioPorts[port];
                    watch.on('change', async (value) => {
                        this.log.debug('GPIO change on port ' + port + ': ' + value);
                        if (this.gpioPortLastWrite[port] === undefined) {
                            this.gpioPortLastWrite[port] = 0;
                        }
                        if (Date.now() - this.gpioPortLastWrite[port] < this.config.inputDebounceMs) {
                            this.log.debug(`Ignoring change event due to debounce: ${(Date.now() - this.gpioPortLastWrite[port])}ms < ${this.config.inputDebounceMs}.`);
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
     * @returns {Promise<void> | void}
     */
    async readValue(port, value) {
        if (this.gpioPorts[port]) {
            try {
                if (typeof value === 'undefined') {
                    value = this.gpioPorts[port].value;
                }
                this.log.debug(`Setting state for port ${port} to ${value}`);
                this.gpioPortLastWrite[port] = Date.now();
                await this.adapter.setStateChanged('gpio.' + port + '.state', this.inputPullUp(value), true);
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
            value = (await this.adapter.getStateAsync('gpio.' + port + '.state'))?.val;
        }

        port = parseInt(port, 10);
        if (!this.config.gpios[port] || !this.config.gpios[port].enabled) {
            this.log.warn('Port ' + port + ' is not writable, because disabled.');
            return;
        } else if (this.config.gpios[port].input === 'in' || this.config.gpios[port].input === 'true' || this.config.gpios[port].input === true) {
            return this.log.warn('Port ' + port + ' is configured as input and not writable');
        }

        if (value === 'true')  value = true;
        if (value === 'false') value = false;
        if (value === '0')     value = false;
        value = !!value;

        try {
            if (this.gpioPorts[port]) {
                try {
                    let invert = false;
                    if (this.config.gpios[port].input === 'outhigh') {
                        this.log.debug(`Inverting value from ${value} to ${!value} for port ${port} because set to ${this.config.gpios[port].input}`);
                        invert = true;
                    }

                    this.gpioPorts[port].value = invert ? !value : value;
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
     * Converts value depending on inputPullUp setting.
     * @param value {number|boolean}
     * @returns {boolean}
     */
    inputPullUp(value) {
        return !!(this.config.inputPullUp ? !value : value);
    }

    /**
     * Cleanup on unload.
     * @returns {Promise<void>}
     */
    async unload() {
        // Cancel any debounceTimers
        if (this.gpioChip && typeof this.gpioChip.close === 'function') {
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

// Which button events will we capture and have states for?
// See https://www.npmjs.com/package/rpi-gpio-buttons
//const buttonEvents = [ 'pressed', 'clicked', 'clicked_pressed', 'double_clicked', 'released' ];
const buttonEvents = ['state'];

const util = require('node:util');
const exec = util.promisify(require('node:child_process').exec);

/**
 * Raspberry Pi generation from the device tree model, e.g. 5 for "Raspberry Pi 5 Model B",
 * "Raspberry Pi 500" or "Raspberry Pi Compute Module 5" - all of them use the RP1 GPIO chip.
 *
 * @param model {string} content of /proc/device-tree/model
 * @returns {number} generation; 0 if unknown or not numbered by generation (the Zero family, which
 *  shares its GPIO chip with the Pi 1-4)
 */
function raspberryGeneration(model) {
    const match = /Raspberry Pi (?:Compute Module )?(\d+)/.exec(model);
    if (!match) {
        return 0;
    }
    const number = parseInt(match[1], 10);
    // keyboard models: 400 is a Pi 4, 500 is a Pi 5
    return number >= 100 ? Math.floor(number / 100) : number;
}

/**
 * GPIO chip that drives the 40 pin header. From the Pi 5 on this is the RP1 chip, which the adapter
 * addresses as /dev/gpiochip4; on all older boards it is /dev/gpiochip0.
 *
 * @param model {string} content of /proc/device-tree/model
 * @returns {number} chip number
 */
function headerGpioChip(model) {
    return raspberryGeneration(model) >= 5 ? 4 : 0;
}

/**
 * Class to control GPIO ports.
 */
class GpioControl {
    /**
     * Constructor
     *
     * @param adapter {ioBroker.Adapter}
     * @param log {ioBroker.Logger}
     */
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
     *
     * @param gpioPorts {Array<Object>}
     * @param buttonPorts {Array<Object>}
     * @returns undefined
     */
    async setupGpio(gpioPorts, buttonPorts) {
        if (gpioPorts.length === 0 && buttonPorts.length === 0) {
            return;
        }

        try {
            const { Default, Edge } = require('@garfonso/opengpio');
            //mock... maybe move that to test library in future.
            //const Default = { watch: () => { return {value: false, on: () => {}} }, output: () => { return {value: false}}};
            //const Edge = { Both: 1};

            let chipNum = 0;
            try {
                const { stdout } = await exec('cat /proc/device-tree/model');
                const model = stdout.replace(/\0/g, '').trim();
                chipNum = headerGpioChip(model);
                this.log.debug(
                    `Board "${model}" (Raspberry Pi generation ${raspberryGeneration(model)}), using GPIO chip ${chipNum}.`,
                );
            } catch (e) {
                this.log.error(`Cannot read CPU Info: ${e}`);
            }

            this.gpioChip = Default;
            if (this.gpioChip === undefined) {
                this.log.warn('Cannot initialize GPIO: No chip found. GPIO functionality disabled!');
                this.log.warn(
                    'Please make sure that libgpiod-dev (on raspian/debian run sudo apt install libgpiod-dev) is installed in the system and then reinstall the adapter.',
                );
                this.log.warn(
                    'If the library is installed and npm list | grep opengpio shows the npm library is also installed, please report this issue to the adapter developer with the model of your device and deboug output from an adapter start.',
                );
            }
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
                        const watch = this.gpioChip.watch({ chip: chipNum, line: gpioSetting.gpio }, Edge.Both);
                        this.gpioPorts[gpioSetting.gpio] = watch;
                        this.gpioInputPorts.push(gpioSetting.gpio);
                    } else {
                        // The line has to be claimed with its target level right away: libgpiod
                        // defaults an output to low while requesting it, so every output would
                        // glitch low until the initial value is written further down (#431).
                        const initialValue = this.getInitialOutputValue(gpioSetting);
                        const pin = this.gpioChip.output(
                            { chip: chipNum, line: gpioSetting.gpio },
                            { value: initialValue },
                        );
                        this.gpioPorts[gpioSetting.gpio] = pin;
                        this.gpioOutputPorts.push(gpioSetting.gpio);
                    }
                }
                for (const gpioSetting of buttonPorts) {
                    //still the same as input ports...
                    this.gpioSettings[gpioSetting.gpio] = gpioSetting; //keep settings for later.
                    const watch = this.gpioChip.watch({ chip: chipNum, line: gpioSetting.gpio }, Edge.Both);
                    this.gpioPorts[gpioSetting.gpio] = watch;
                    this.gpioInputPorts.push(gpioSetting.gpio);
                }

                this.log.debug(`Watching ${this.gpioInputPorts.length} input port(s).`);

                for (const port of this.gpioInputPorts) {
                    this.log.debug(`Adding event listener for port ${port}`);
                    const watch = this.gpioPorts[port];
                    watch.on('change', async value => {
                        this.log.debug(`GPIO change on port ${port}: ${value}`);
                        if (this.gpioPortLastWrite[port] === undefined) {
                            this.gpioPortLastWrite[port] = 0;
                        }
                        if (Date.now() - this.gpioPortLastWrite[port] < this.gpioSettings[port].debounceOrPoll) {
                            this.log.debug(
                                `Ignoring change event due to debounce: ${Date.now() - this.gpioPortLastWrite[port]}ms < ${this.gpioSettings[port].debounceOrPoll}.`,
                            );
                            return;
                        }
                        await this.readValue(port, value);
                    });
                    await this.readValue(port);
                }

                //write initial values to output ports - do people want that?:
                for (const port of this.gpioOutputPorts) {
                    if (!this.hasInitialOutputValue(this.gpioSettings[port])) {
                        // Nothing configured, but the line is physically driven low as long as it
                        // is claimed - report that instead of leaving a stale state behind.
                        this.log.debug(`Setting no initial value for port ${port}`);
                        await this.adapter.setState(`gpio.${port}.state`, false, true);
                        continue;
                    }
                    await this.writeGpio(port);
                }

                // Setup any buttons using the same rpi-gpio object as other I/O.
                if (buttonPorts.length > 0) {
                    this.log.error(
                        'Button ports not yet supported... not sure if they ever will be - please discuss in github: https://github.com/iobroker-community-adapters/ioBroker.rpi2/issues/192 - if cannot make an account and have something constructive and new to add, contact Garfonso.',
                    );
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
            this.log.error(`Cannot initialize/setMode GPIO: ${e}`);
            this.log.error(
                'Please make sure that libgpiod-dev (on raspian/debian run sudo apt install libgpiod-dev) is installed in the system and then reinstall the adapter.',
            );
            console.error(e);
            if (e.message.includes('NODE_MODULE_VERSION')) {
                return this.adapter.terminate('A dependency requires a rebuild.', 13);
            }
        }
    }

    /**
     * Check if a port configuration defines an initial output value.
     *
     * @param gpioSetting {object} port configuration
     * @returns {boolean} true if the configuration selects a defined start level
     */
    hasInitialOutputValue(gpioSetting) {
        return gpioSetting.configuration === 'outhigh' || gpioSetting.configuration === 'outlow';
    }

    /**
     * Determine the level an output line has to be claimed with. Mirrors the conversion
     * writeGpio() does, so hardware and state stay in sync from the very first moment.
     *
     * @param gpioSetting {object} port configuration
     * @returns {boolean} the level the line is claimed with
     */
    getInitialOutputValue(gpioSetting) {
        if (!this.hasInitialOutputValue(gpioSetting)) {
            // No initial value configured -> keep the line at the driver default.
            return false;
        }
        const value = gpioSetting.configuration === 'outhigh';
        return gpioSetting.invert ? !value : value;
    }

    /**
     * Read the value of a GPIO port and update the corresponding state.
     *
     * @param port {number}
     * @param [value] {boolean}
     * @returns Promise<void>
     */
    async readValue(port, value) {
        if (this.gpioPorts[port]) {
            try {
                if (value === undefined) {
                    value = this.gpioPorts[port].value;
                    this.log.debug(`Read ${value} from port ${port}.`);
                }
                if (this.gpioSettings[port].invert) {
                    value = !value;
                }
                this.gpioPortLastWrite[port] = Date.now();
                value = this.gpioSettings[port].pullUp ? !value : value;
                this.log.debug(`Setting state for port ${port} to ${value}`);
                await this.adapter.setState(`gpio.${port}.state`, Boolean(value), true);
            } catch (err) {
                this.log.error(`Cannot read port ${port}: ${err}`);
            }
        }
    }

    /**
     * Write a value to a GPIO port and update the corresponding state.
     *
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
                this.log.debug(`Setting no initial value for port ${port}`);
                return;
            }
            this.log.debug(`Setting initial value for port ${port} to ${value}`);
        }

        if (typeof port === 'string') {
            port = parseInt(port, 10);
        }
        if (!this.gpioSettings[port]) {
            this.log.warn(`Port ${port} is not writable, because disabled.`);
            return;
        } else if (!this.gpioSettings[port].configuration.startsWith('out')) {
            this.log.warn(`Port ${port} is configured as input and not writable`);
            if (this.gpioSettings[port].configuration === 'in') {
                await this.readValue(port);
            }
            return;
        }

        if (value === 'true') {
            value = true;
        }
        if (value === 'false') {
            value = false;
        }
        if (value === '0') {
            value = false;
        }
        value = !!value;
        if (this.gpioSettings[port].invert) {
            value = !value;
        }

        try {
            if (this.gpioPorts[port]) {
                try {
                    this.gpioPorts[port].value = value;
                    this.log.debug(`Written ${value} into port ${port}`);
                    await this.adapter.setState(`gpio.${port}.state`, value, true);
                } catch (err) {
                    this.log.error(`Cannot write port ${port}: ${err}`);
                }
            } else {
                this.log.error('GPIO is not initialized!');
            }
        } catch (error) {
            this.log.error(`Cannot write port ${port}: ${error}`);
        }
    }

    /**
     * Cleanup on unload.
     *
     * @returns Promise<void>
     */
    async unload() {
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
exports.raspberryGeneration = raspberryGeneration;
exports.headerGpioChip = headerGpioChip;

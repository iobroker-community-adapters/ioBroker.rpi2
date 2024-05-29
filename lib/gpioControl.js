// Which button events will we capture and have states for?
// See https://www.npmjs.com/package/rpi-gpio-buttons
const buttonEvents = [ 'pressed', 'clicked', 'clicked_pressed', 'double_clicked', 'released' ];

class GpioControl {
    constructor(adapter, log) {
        this.adapter = adapter;
        this.gpioChip = null;
        //this.gpioButtons = null;
        this.config = adapter.config;
        this.debounceTimers = [];
        this.log = log;
        this.gpioPorts = [];
        this.gpioInputPorts = [];
        this.gpioInputPortsHandler = null;
    }

    /**
     * Setup GPIO ports & buttons
     * @param gpioPorts {number[]}
     * @param buttonPorts {number[]}
     * @returns undefined
     */
    setupGpio(gpioPorts, buttonPorts) {
        if (gpioPorts.length === 0 && buttonPorts.length === 0) return;

        try {
            const { openGpioChip, Input, Output } = require('easy-gpiod');
            const chipPath = '/dev/gpiochip0'; //for now always use chip 0. This *might* fail for raspberry 5?
            //this.log.debug(openGpioChip);
            //this.log.debug(Input);
            //this.log.debug(Output);

            this.log.debug('Inputs are pull ' + (this.config.inputPullUp ? 'up' : 'down') + '.');
            this.log.debug('Buttons are pull ' + (this.config.buttonPullUp ? 'up' : 'down') + '.');

            this.gpioChip = openGpioChip(chipPath);
            this.log.debug('Got chip: ' + this.gpioChip);
            this.log.debug(`GPIO chip ${JSON.stringify(this.gpioChip?.info)} initialized`);

            if (this.gpioChip) {
                // Setup all the regular GPIO input and outputs.

                const lineParameters = {};
                for (const port of gpioPorts) {
                    const direction = this.config.gpios[port].input;
                    this.log.debug(`Port ${port} direction: ${direction}`);

                    if (direction === 'in') {
                        lineParameters[port] = Input(port,{
                            //somehow can not configure pull-down... or is pull-down active, if we don't do pull-up?
                            bias: this.config.inputPullUp ? 'pull-up' : 'pull-down',
                            risingEdge: true,
                            fallingEdge: true,
                            debounce: this.config.inputDebounceMs
                        });
                        this.gpioInputPorts.push(port);
                    } else {
                        lineParameters[port] = Output(port, {
                            value: direction === 'outlow',
                            activeLow: direction === 'outlow'
                        });
                    }
                }
                for (const buttonPort of buttonPorts) {
                    lineParameters[buttonPort] = Input(buttonPort, {
                        bias: this.config.buttonPullUp ? 'pull-up' : 'pull-down',
                        debauce: this.config.buttonDebounceMs,
                        risingEdge: true,
                        fallingEdge: true
                    });
                    this.gpioInputPorts.push(buttonPort);
                }

                this.gpioPortsRequest = this.gpioChip.requestLines(`iobroker.${this.adapter.namespace}`,lineParameters);
                this.gpioPorts = this.gpioPortsRequest.lines;

                for (const port of this.gpioInputPorts) {
                    this.log.debug(`Adding event listener for port ${port}`);
                    //for now, let library handle debounce... if that does not work, see in old code what debounce timers did.
                    this.gpioPorts[port].on('change', (value) => {
                        this.readValue(port, value);
                    });
                }

                // Setup any buttons using the same rpi-gpio object as other I/O.
                if (buttonPorts.length > 0) {
                    this.log.error('Button ports not yet supported... not sure if they ever will be?');
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
            console.error(e);
            if (e.message.includes('NODE_MODULE_VERSION')) {
                return this.adapter.terminate('A dependency requires a rebuild.', 13);
            }
        }
    }

    /**
     * Read the value of a GPIO port and update the corresponding state.
     * @param port {number}
     * @param value {boolean}
     * @returns {Promise<void> | void}
     */
    async readValue(port, value) {
        if (this.gpioPorts[port]) {
            try {
                //const value = this.gpioPorts[port].getValue();
                await this.adapter.setStateChanged('gpio.' + port + '.state', this.inputPullUp(value), true);
            } catch (err) {
                this.log.error('Cannot read port ' + port + ': ' + err);
            }
        }
    }

    /**
     * Write a value to a GPIO port and update the corresponding state.
     * @param port {number|string}
     * @param value {boolean|string}
     */
    async writeGpio(port, value) {
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
        for (const timer of this.debounceTimers) {
            if (timer != null) {
                this.adapter.clearTimeout(timer);
            }
        }
        if (this.gpioChip) {
            this.gpioChip.close();
        }
        for (const gpioLine of this.gpioPorts) {
            if (gpioLine) {
                try {
                    gpioLine.release();
                } catch (err) {
                    console.error(`Failed to release gpioLine: ${err}`);
                }
            }
        }
        this.adapter.clearInterval(this.gpioInputPortsHandler);
    }
}

exports.buttonEvents = buttonEvents;
exports.GpioControl = GpioControl;

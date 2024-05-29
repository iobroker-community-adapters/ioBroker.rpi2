// Which button events will we capture and have states for?
// See https://www.npmjs.com/package/rpi-gpio-buttons
const buttonEvents = [ 'pressed', 'clicked', 'clicked_pressed', 'double_clicked', 'released' ];

//TODO: somehow import of LineFlags does not work.. maybe only in TS? Augment it ourself...
/**
 * LineFlags
 * Those flags where introduced in libgpiod 1.5 and allows to fine tune how
 * line should behave.
 */
const TemporaryLineFlags = {
    GPIOD_LINE_REQUEST_FLAG_OPEN_DRAIN: 1,
    GPIOD_LINE_REQUEST_FLAG_OPEN_SOURCE: 2,
    GPIOD_LINE_REQUEST_FLAG_ACTIVE_LOW: 4,
    GPIOD_LINE_REQUEST_FLAG_BIAS_DISABLE: 8,
    GPIOD_LINE_REQUEST_FLAG_BIAS_PULL_DOWN: 16,
    GPIOD_LINE_REQUEST_FLAG_BIAS_PULL_UP: 32
};

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
            const { Chip, Line, LineFlags, available } = require('node-libgpiod');
            this.log.debug(Chip);
            this.log.debug(Line);
            this.log.debug(LineFlags);
            this.log.debug(available);
            const LineFlagsToUse = LineFlags || TemporaryLineFlags;
            if (!available()) {
                this.log.error('GPIO not available on this system.');
                return;
            }

            this.log.debug('Inputs are pull ' + (this.config.inputPullUp ? 'up' : 'down') + '.');
            this.log.debug('Buttons are pull ' + (this.config.buttonPullUp ? 'up' : 'down') + '.');


            this.gpioChip = new Chip(0);
            this.log.debug('Got chit: ' + this.gpioChip);
            this.numberOfPins = this.gpioChip.getNumberOfLines();
            this.log.debug(`GPIO chip ${this.gpioChip.getChipName()} with label ${this.gpioChip.getChipLabel()} and ${this.gpioChip.getNumberOfLines()} PINs initialized`);

            if (this.gpioChip) {
                // Setup all the regular GPIO input and outputs.
                for (const port of gpioPorts) {
                    const direction = this.config.gpios[port].input;
                    this.log.debug(`Port ${port} direction: ${direction}`);
                    try {
                        this.gpioPorts[port] = new Line(this.gpioChip, port);
                    } catch (err) {
                        this.log.error(`Cannot setup port ${port}: ${err}`);
                        continue;
                    }

                    if (direction === 'in') {
                        // Input port
                        try {
                            //request pin to be input, set consumer name to this adapter instance and port. Hm.
                            this.gpioPorts[port].requestInputModeFlags(`ioBroker.${this.adapter.namespace}.${port}`, this.config.inputPullUp ?
                                LineFlagsToUse.GPIOD_LINE_REQUEST_FLAG_BIAS_PULL_UP : LineFlagsToUse.GPIOD_LINE_REQUEST_FLAG_BIAS_DISABLE); //if no pull up, deactivate resistors. Is that correct? Or do we want pull down, then?
                            this.readValue(port);
                            this.gpioInputPorts.push(port);
                        } catch (err) {
                            this.log.error(`Cannot setup port ${port} as input: ${err}`);
                        }
                    } else {
                        // All the different flavors of output
                        try {
                            //Request pin to be output. 1 means default of pin is high. I.e. 0 means low.
                            this.gpioPorts[port].requestOutputMode(direction === 'outhigh' ? 1 : 0, `ioBroker.${this.adapter.namespace}.${port}`);
                        } catch (err) {
                            this.log.error(`Cannot setup port ${port} as output: ${err}`);
                        }
                    }
                }

                // Setup input change handler - only has to be done once no matter how many inputs we have.
                if (this.gpioInputPorts.length > 0) {
                    //sadly no event emitter, so we have to poll. But we can do that in a setInterval.
                    this.gpioInputPortsHandler = this.adapter.setInterval(() => {
                        for (const port of this.gpioInputPorts) {
                            this.readValue(port);
                        }
                    }, this.config.inputPollIntervalMs || 200);
                    /* keep old code to later incorporate debounce stuff and so on...
                    this.gpio.on('change', (port, value) => {
                        // Ignore buttons as they are handled below
                        if (this.adapter.config.gpios[port].input === 'in') {
                            this.log.debug('GPIO change on port ' + port + ': ' + value);
                            if (this.debounceTimers[port] !== null) {
                                // Timer is running, but the state changed (must be back) so just cancel timer.
                                clearTimeout(this.debounceTimers[port]);
                                this.debounceTimers[port] = null;
                            } else {
                                // Start a timer and report to state if it doesn't revert within a given period.
                                this.debounceTimers[port] = this.adapter.setTimeout(async (t_port, t_value) => {
                                    this.debounceTimers[t_port] = null;
                                    this.log.debug(`GPIO debounced on port ${t_port}: ${t_value}`);
                                    await this.adapter.setStateAsync('gpio.' + t_port + '.state', this.inputPullUp(t_value), true);
                                }, this.config.inputDebounceMs, port, value);
                            }
                        }
                    });*/
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
     * @returns {Promise<void> | void}
     */
    async readValue(port) {
        if (this.gpioPorts[port]) {
            try {
                const value = this.gpioPorts[port].getValue();
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
                    this.gpioPorts[port].setValue(value);
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

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const {
    raspberryGeneration,
    headerGpioChip,
    inputOptions,
    describeInputOptions,
    GpioControl,
} = require('./lib/gpioControl');

// enum values of @garfonso/opengpio, which cannot be loaded without libgpiod
const Bias = { AsIs: 1, Unknown: 2, Disabled: 3, PullUp: 4, PullDown: 5 };
const Edge = { Rising: 0, Falling: 1, Both: 2 };

// model strings as found in /proc/device-tree/model
const boards = [
    { model: 'Raspberry Pi 5 Model B Rev 1.0', generation: 5, chip: 4 },
    { model: 'Raspberry Pi 500 Rev 1.0', generation: 5, chip: 4 },
    { model: 'Raspberry Pi Compute Module 5 Rev 1.0', generation: 5, chip: 4 },
    { model: 'Raspberry Pi 4 Model B Rev 1.5', generation: 4, chip: 0 },
    { model: 'Raspberry Pi 400 Rev 1.0', generation: 4, chip: 0 },
    { model: 'Raspberry Pi Compute Module 4 Rev 1.1', generation: 4, chip: 0 },
    { model: 'Raspberry Pi 3 Model B Plus Rev 1.3', generation: 3, chip: 0 },
    { model: 'Raspberry Pi 2 Model B Rev 1.1', generation: 2, chip: 0 },
    { model: 'Raspberry Pi Zero 2 W Rev 1.0', generation: 0, chip: 0 },
    { model: 'Raspberry Pi Zero W Rev 1.1', generation: 0, chip: 0 },
    { model: '', generation: 0, chip: 0 },
];

describe('board detection', () => {
    for (const { model, generation, chip } of boards) {
        it(`"${model}" is generation ${generation} and uses GPIO chip ${chip}`, () => {
            expect(raspberryGeneration(model)).to.equal(generation);
            expect(headerGpioChip(model)).to.equal(chip);
        });
    }

    it('ignores the trailing NUL of the device tree string', () => {
        expect(headerGpioChip('Raspberry Pi 5 Model B Rev 1.0\0')).to.equal(4);
    });
});

describe('input options', () => {
    it('leaves the bias alone if no pull resistor is selected', () => {
        expect(inputOptions({}, Bias)).to.deep.equal({});
        expect(inputOptions({ pullUp: false, pullDown: false, debounceOrPoll: 0 }, Bias)).to.deep.equal({});
    });

    it('selects the pull resistor', () => {
        expect(inputOptions({ pullUp: true }, Bias)).to.deep.equal({ bias: Bias.PullUp });
        expect(inputOptions({ pullDown: true }, Bias)).to.deep.equal({ bias: Bias.PullDown });
        expect(inputOptions({ pullUp: true, pullDown: true }, Bias)).to.deep.equal({ bias: Bias.PullUp });
    });

    it('passes the debounce time to the kernel', () => {
        expect(inputOptions({ debounceOrPoll: 50 }, Bias)).to.deep.equal({ debounce: 50 });
        expect(inputOptions({ debounceOrPoll: '20', pullUp: true }, Bias)).to.deep.equal({
            bias: Bias.PullUp,
            debounce: 20,
        });
    });

    it('describes the options for the log', () => {
        expect(describeInputOptions({ bias: Bias.PullUp, debounce: 50 }, Bias)).to.equal('pull-up and 50 ms debounce');
        expect(describeInputOptions({ bias: Bias.PullDown }, Bias)).to.equal('pull-down');
        expect(describeInputOptions({}, Bias)).to.equal('no pull resistor and no debounce');
    });
});

/**
 * GpioControl with a fake adapter and a fake opengpio Default device.
 *
 * @param refuse {(options: {bias?: number, debounce?: number}) => boolean} which watch requests fail
 */
function createControl(refuse = () => false) {
    /** @type {{debug: string[], warn: string[], error: string[]}} */
    const logs = { debug: [], warn: [], error: [] };
    /** @type {{id: string, value: unknown}[]} */
    const states = [];
    const adapter = {
        setState: async (id, value) => states.push({ id, value }),
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: timer => clearTimeout(timer),
    };
    const log = {
        debug: msg => logs.debug.push(msg),
        info: () => {},
        warn: msg => logs.warn.push(msg),
        error: msg => logs.error.push(msg),
    };
    /** @type {object[]} */
    const requests = [];
    const Default = {
        watch: (gpio, edge, options) => {
            requests.push(options);
            if (refuse(options)) {
                throw new Error('Operation not supported');
            }
            return { value: false, on: () => {} };
        },
    };
    const control = new GpioControl(/** @type {any} */ (adapter), /** @type {any} */ (log));
    return { control, logs, states, requests, opengpio: { Default, Edge, Bias } };
}

describe('claiming inputs', () => {
    const setting = { gpio: 17, configuration: 'in', pullUp: true, debounceOrPoll: 50 };

    it('requests pull resistor and debounce from the kernel', () => {
        const { control, logs, requests, opengpio } = createControl();
        expect(control.claimInput(opengpio, 0, setting)).to.equal(true);
        expect(requests).to.deep.equal([{ bias: Bias.PullUp, debounce: 50 }]);
        expect(control.gpioInputPorts).to.deep.equal([17]);
        expect(control.softwareDebounce[17]).to.equal(0);
        expect(logs.error).to.be.empty;
    });

    it('debounces in the adapter if the kernel cannot', () => {
        const { control, logs, requests, opengpio } = createControl(options => !!options.debounce);
        expect(control.claimInput(opengpio, 0, setting)).to.equal(true);
        expect(requests).to.deep.equal([{ bias: Bias.PullUp, debounce: 50 }, { bias: Bias.PullUp }]);
        expect(control.softwareDebounce[17]).to.equal(50);
        expect(logs.error).to.have.length(1);
        expect(logs.error[0]).to.contain('pull-up and 50 ms debounce').and.contain('Operation not supported');
    });

    it('falls back to a plain input if the pull resistor is refused', () => {
        const { control, logs, requests, opengpio } = createControl(options => !!options.bias);
        expect(control.claimInput(opengpio, 0, setting)).to.equal(true);
        expect(requests).to.deep.equal([{ bias: Bias.PullUp, debounce: 50 }, { bias: Bias.PullUp }, {}]);
        expect(control.softwareDebounce[17]).to.equal(50);
        expect(logs.error).to.have.length(1);
    });

    it('logs and skips an input that cannot be claimed at all', () => {
        const { control, logs, requests, opengpio } = createControl(() => true);
        expect(control.claimInput(opengpio, 0, { gpio: 4, configuration: 'in' })).to.equal(false);
        expect(requests).to.deep.equal([{}]);
        expect(control.gpioInputPorts).to.be.empty;
        expect(logs.error).to.deep.equal(['Cannot set up GPIO 4 as input: Error: Operation not supported']);
    });

    it('warns if both pull resistors are selected', () => {
        const { control, logs, opengpio } = createControl();
        control.claimInput(opengpio, 0, { gpio: 5, configuration: 'in', pullUp: true, pullDown: true });
        expect(logs.warn).to.have.length(1);
    });
});

describe('input changes', () => {
    let clock;
    beforeEach(() => {
        clock = sinon.useFakeTimers();
    });
    afterEach(() => {
        clock.restore();
    });

    it('reports changes right away if the kernel debounces', async () => {
        const { control, states, opengpio } = createControl();
        control.claimInput(opengpio, 0, { gpio: 17, configuration: 'in', debounceOrPoll: 50 });
        control.gpioSettings[17] = { gpio: 17, configuration: 'in' };
        await control.onInputChange(17, true);
        expect(states).to.deep.equal([{ id: 'gpio.17.state', value: true }]);
    });

    it('reports only the stable level if the adapter debounces', async () => {
        const { control, states, opengpio } = createControl(options => !!options.debounce);
        control.claimInput(opengpio, 0, { gpio: 17, configuration: 'in', pullUp: true, debounceOrPoll: 50 });
        control.gpioSettings[17] = { gpio: 17, configuration: 'in', pullUp: true };
        // a bouncing switch closing: low, high, low within a few ms
        await control.onInputChange(17, false);
        await clock.tickAsync(3);
        await control.onInputChange(17, true);
        await clock.tickAsync(3);
        await control.onInputChange(17, false);
        expect(states).to.be.empty;
        await clock.tickAsync(50);
        // pull-up: low level means the switch is closed
        expect(states).to.deep.equal([{ id: 'gpio.17.state', value: true }]);
    });
});

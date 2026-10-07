'use strict';

const { expect } = require('chai');
const { raspberryGeneration, headerGpioChip } = require('./lib/gpioControl');

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

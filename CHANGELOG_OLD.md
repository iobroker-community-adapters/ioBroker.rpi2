# Older Changes
## 2.1.0 (2024-10-13)
* (jangatzke) add support for gpios on Raspberry Zero.

## 2.0.1 (2024-10-07)
* (Garfonso) make gpio library required dependency
* (Garfonso) make errors clearer, if gpio library could not be initialized.

## 2.0.0 (2024-06-24)
* (Garfonso) reworked GPIO input and output to work with Bookworm.
* (Garfonso) BREAKING CHANGE: removed support for GPIO-Buttons. 
* (Garfonso) BREAKING CHANGE: remove unsupported button states and create input state.
* (Garfonso) add support for Raspberry 5.
* (Garfonso) on startup set GPIO outputs from ioBroker states.
* (Garfonso) switch to opengpio library.
* (Grothesk242) fixed: reading network and filesystem statistics.
* (Garfonso) move parsers from io-package.json to separate file.
* (Garfonso) get rid of old sync-exec.
* (Garfonso) Get development stuff up to date...

## 1.3.2 (2022-02-17)
* Important: This version requires at leas js-controller 3.3
* (Apollon77) Stop the adapter when GPIO module is configured but not working due to a needed rebuild that js-controller can pick up

## 1.3.1 (2021-07-16)
* (Apollon77) Prevent js-controller 3.3 warnings

## 1.3.0 (2021-07-16)
* (asgothian) Fix to get CPU frequencies also on Raspi 4
* (raintor) Add support for DHTxx/AM23xx Sensors
* (raintor) Configure internal Pull UP/Down Resistor
* (raintor) Add port 'label'/'friendly name' to GPIO config

## 1.2.0 (2020-01-17)
- (janfromberlin) GPIO configuration as output with defined initial value
- (foxriver76) No longer use adapter.objects
- (Apollon77) Adjust gpio errors

## 1.1.1
- (Apollon77) Error messages for not existing values are logged only once

## 1.1.0
 - (Apollon77) Nodejs 10 support

## 1.0.0 (2018-08-20)
 - (bluefox) Admin3 support

## 0.3.2 (2017-11-29)
 - (Homoran) fixed Mem available readings on Stretch

## 0.3.1 (2017-01-11)
 - (olifre) Fixup swap_used calculation.

## 0.2.2 (2016-12-01)
 - (bluefox) Add GPIO direction indication

## 0.2.2 (2016-11-22)
 - (bluefox) Use BCM enumeration

## 0.2.1 (2016-10-29)
 - (bluefox) fix start of adapter

## 0.2.0 (2016-10-23)
 - (bluefox) just version change

## 0.1.1 (2016-10-13)
 - (bluefox) implement GPIOs control

## 0.0.4 (2016-03-25)
 - (bluefox) Try catch by eval
   (bluefox) do not process if exec fails

## 0.0.3 (2015-12-28)
 - (husky-koglhof) Fixed value calc.
   Set Value to 2 digits

## 0.0.2 (2015-12-26)
 - (husky-koglhof) Workaround for node 0.10.x
 - (bluefox) Some Fixes

## 0.0.1 (2015-12-23)
 - Initial commit. Alpha Version.

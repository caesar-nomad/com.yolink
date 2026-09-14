'use strict';

const YoLinkDevice = require('../yoLinkDevice');

module.exports = class DoorSensorDevice extends YoLinkDevice
{

	/**
   * onInit is called when the device is initialized.
   */
	async onInit()
	{
		this.refreshState().catch(this.error);
		this.homey.app.updateLog('DoorSensorDevice has been initialized');
	}

	/**
   * onAdded is called when the user adds the device, called just after pairing.
   */
	async onAdded()
	{
		this.refreshState().catch(this.error);
		this.homey.app.updateLog('DoorSensorDevice has been added');
	}

	/**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
	async onSettings({ oldSettings, newSettings, changedKeys })
	{
		this.homey.app.updateLog('DoorSensorDevice settings were changed');
	}

	/**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
	async onRenamed(name)
	{
		this.homey.app.updateLog('DoorSensorDevice was renamed');
	}

	/**
   * onDeleted is called when the user deleted the device.
   */
	async onDeleted()
	{
		this.homey.app.updateLog('DoorSensorDevice has been deleted');
	}

	async updateState()
	{
		const data = await this.getData();
		const settings = await this.getSettings();
		const state = await this.driver.getState(data, settings);
		this.unsetWarning().catch(this.herror);
		if (!state || !state.data || !state.data.online || state.data.online !== true)
		{
			if (state && state.state === 'error')
			{
				this.homey.app.updateLog(`Error updating state for device ${data.id}: ${state.msg}`, 0);
				this.setWarning(`Error: ${state.msg}`).catch(this.error);
				return false;
			}
			this.setUnavailable('Offline').catch(this.error);
			return false;
		}
		this.setAvailable().catch(this.error);

		this.setCapabilityValue('alarm_contact', state.data.state.state === 'open').catch(this.error);

		// If the door is open and the time now is greater than the openRemindDelay + the stateChangedAt time, then set the alarm_door_fault to true
		if ((state.data.state.state === 'open') && (Date.now() > (state.data.state.stateChangedAt + (state.data.state.openRemindDelay * 1000))))
		{
			this.setCapabilityValue('alarm_door_fault', true).catch(this.error);
		}
		else
		{
			this.setCapabilityValue('alarm_door_fault', false).catch(this.error);
		}

		// The returned battery is a string with a level between 0 and 4, so convert to 0 to 1
		if (state.data.state.battery)
		{
			const batteryLevel = parseInt(state.data.state.battery, 10) / 0.04;
			this.setCapabilityValue('measure_battery', batteryLevel).catch(this.error);
		}

		this.driver.updateMQTTState(data);

		return true;
	}

	async processMQTTMessage(mqttMessage)
	{
		let mqttData;
		let deviceId;
		// Check if the event field is present so we know what type of message this is
		if (mqttMessage.event)
		{
			mqttData = mqttMessage.data;
			deviceId = mqttMessage.deviceId;
		}
		else
		{
			mqttData = mqttMessage.data.state;
			deviceId = mqttMessage.targetDevice;
		}

		if (deviceId !== this.getData().id)
		{
			return false;
		}

		this.markOnline();

		// Log the device status
		this.homey.app.updateLog(`DoorSensorDevice MQTT message received: ${JSON.stringify(mqttData)}`);

		// Process the MQTT message
		if (mqttData.alertType)
		{
			if (mqttData.alertType === 'openRemind')
			{
				this.setCapabilityValue('alarm_door_fault', true).catch(this.error);
			}
			else
			{
				this.setCapabilityValue('alarm_door_fault', false).catch(this.error);
			}
		}

		this.setCapabilityValue('alarm_contact', mqttData.state === 'open').catch(this.error);

		if (mqttData.battery)
		{
			const batteryLevel = parseInt(mqttData.battery, 10) / 0.04;
			this.setCapabilityValue('measure_battery', batteryLevel).catch(this.error);
		}
		return true;
	}
};

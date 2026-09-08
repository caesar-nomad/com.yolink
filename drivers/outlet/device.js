'use strict';

const YoLinkDevice = require('../yoLinkDevice');

module.exports = class outletDevice extends YoLinkDevice
{

	/**
	 * onInit is called when the device is initialized.
	 */
	async onInit()
	{
		// Add the capability listener for the OnOff capability
		this.registerCapabilityListener('onoff', this.onOffCapabilityListener.bind(this));

		this.refreshState().catch(this.error);
		this.homey.app.updateLog('OutletDevice has been initialized');
	}

	/**
	 * onAdded is called when the user adds the device, called just after pairing.
	 */
	async onAdded()
	{
		this.refreshState().catch(this.error);
		this.homey.app.updateLog('OutletDevice has been added');
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
		this.homey.app.updateLog('OutletDevice settings were changed');
	}

	/**
	 * onRenamed is called when the user updates the device's name.
	 * This method can be used this to synchronise the name to the device.
	 * @param {string} name The new name
	 */
	async onRenamed(name)
	{
		this.homey.app.updateLog('OutletDevice was renamed');
	}

	/**
	 * onDeleted is called when the user deleted the device.
	 */
	async onDeleted()
	{
		this.homey.app.updateLog('OutletDevice has been deleted');
	}

	async onOffCapabilityListener(value)
	{
		const data = await this.getData();
		const settings = await this.getSettings();

		const response = await this.homey.app.yoLinkAPI.controlDevice(data.UAID, data.id, data.deviceToken, settings.serviceZone, 'Outlet.setState', { state: value ? 'open' : 'close' });

		if (!response || response.desc !== 'Success')
		{
			this.homey.app.updateLog('Failed to control Outlet');
			throw new Error(`Failed to control Outlet ${response ? response.desc : 'No response'}`);
		}

		return true;
	}

	async updateState()
	{
		const data = await this.getData();
		const settings = await this.getSettings();
		const state = await this.driver.getState(data, settings);
		this.unsetWarning().catch(this.herror);
		if (!state || !state.data)
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

		this.setCapabilityValue('onoff', state.data.state === 'open').catch(this.error);
		this.setCapabilityValue('measure_power', state.data.power / 10).catch(this.error);

		this.driver.updateMQTTState(data);

		return true;
	}

	async processMQTTMessage(mqttMessage)
	{
		// Check if the event field is present so we know what type of message this is
		const mqttData = mqttMessage.data;
		const { deviceId } = mqttMessage;

		if (deviceId !== this.getData().id)
		{
			return false;
		}

		this.markOnline();

		// Log the device status
		this.homey.app.updateLog(`OutletDevice MQTT message received: ${JSON.stringify(mqttData)}`);

		this.setCapabilityValue('onoff', mqttData.state === 'open').catch(this.error);

		if (mqttData.power)
		{
			this.setCapabilityValue('measure_power', mqttData.power / 10).catch(this.error);
		}

		return true;
	}
};

'use strict';

const Homey = require('homey');

// First retry after a failed state refresh, then doubled on every further failure up to the maximum.
const STATE_RETRY_MIN_MS = 60 * 1000;
const STATE_RETRY_MAX_MS = 15 * 60 * 1000;

/**
 * Base class for all YoLink devices.
 *
 * Each device polls its state once from the YoLink cloud when it initialises (updateState).
 * If that single request fails (network not ready after a reboot, token refresh hiccup,
 * API rate limit, "can't connect to device", ...) the device used to be marked
 * "Offline" and nothing ever marked it available again until the app was restarted.
 *
 * refreshState() wraps updateState() and keeps retrying with exponential backoff until
 * the device has been reached, and markOnline() lets the MQTT message path flag the
 * device as available as soon as the device is heard from.
 *
 * @class
 * @extends {Homey.Device}
 */
module.exports = class YoLinkDevice extends Homey.Device
{

	/**
	 * Fetch the device state from the cloud and, when that fails, schedule a retry.
	 * updateState() must resolve to true when the device was reached and marked available.
	 * @returns {Promise<boolean>} true when the state was fetched successfully
	 */
	async refreshState()
	{
		this.clearStateRetry();

		let success = false;
		try
		{
			success = (await this.updateState()) === true;
		}
		catch (err)
		{
			this.homey.app.updateLog(`${this.describeDevice()} state refresh failed: ${err.message}`, 0);
		}

		if (success)
		{
			this.stateRetryDelay = STATE_RETRY_MIN_MS;
			return true;
		}

		this.scheduleStateRetry();
		return false;
	}

	/**
	 * Schedule another refreshState() attempt with exponential backoff and a little jitter
	 * so that many devices do not all hit the API at the same moment.
	 */
	scheduleStateRetry()
	{
		if (this.stateRetryTimer)
		{
			return;
		}

		const baseDelay = this.stateRetryDelay || STATE_RETRY_MIN_MS;
		const delay = Math.round(baseDelay * (0.8 + (Math.random() * 0.4)));
		this.stateRetryDelay = Math.min(baseDelay * 2, STATE_RETRY_MAX_MS);

		this.stateRetryTimer = this.homey.setTimeout(() =>
		{
			this.stateRetryTimer = null;
			this.refreshState().catch(this.error);
		}, delay);

		this.homey.app.updateLog(`${this.describeDevice()} state refresh retry scheduled in ${Math.round(delay / 1000)}s`);
	}

	clearStateRetry()
	{
		if (this.stateRetryTimer)
		{
			this.homey.clearTimeout(this.stateRetryTimer);
			this.stateRetryTimer = null;
		}
	}

	/**
	 * Called when a message for this device arrives over MQTT: the device is reachable.
	 */
	markOnline()
	{
		this.setAvailable().catch(this.error);
	}

	describeDevice()
	{
		let id = '';
		try
		{
			const data = this.getData();
			id = data && data.id ? ` ${data.id}` : '';
		}
		catch (err)
		{
			id = '';
		}
		return `${this.constructor.name}${id}`;
	}

	/**
	 * onUninit is called when the device is destroyed (app stopped or device deleted).
	 */
	async onUninit()
	{
		this.clearStateRetry();
	}

};

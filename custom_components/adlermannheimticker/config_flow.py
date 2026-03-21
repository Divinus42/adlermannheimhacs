"""Config flow for the Adler Mannheim integration."""

from homeassistant import config_entries

from .const import DOMAIN


class AdlerMannheimConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Adler Mannheim."""

    VERSION = 1

    async def async_step_user(self, user_input=None):
        """Handle the initial step."""
        # Only allow a single instance
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()

        if user_input is not None:
            return self.async_create_entry(title="Adler Mannheim", data={})

        return self.async_show_form(step_id="user")

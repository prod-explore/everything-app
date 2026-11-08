//! The device token in the OS credential store (Keychain, Credential Manager, Secret Service).
//! Service "everythingapp-device", account = server host (with port when there is one).

use keyring::Entry;

const SERVICE: &str = "everythingapp-device";

fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

pub fn get(account: &str) -> Result<Option<String>, String> {
    match entry(account)?.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn set(account: &str, token: &str) -> Result<(), String> {
    entry(account)?.set_password(token).map_err(|e| e.to_string())
}

pub fn delete(account: &str) -> Result<(), String> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

use std::time::{SystemTime, UNIX_EPOCH};

const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

/// A calendar date (UTC) printed on the kit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Date {
    year: u16,
    month: u8,
    day: u8,
}

impl Date {
    pub fn new(year: u16, month: u8, day: u8) -> Option<Self> {
        ((1..=12).contains(&month) && (1..=31).contains(&day)).then_some(Self { year, month, day })
    }

    /// Today's date in UTC, from the system clock.
    pub fn today() -> Self {
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        Self::from_unix_days(i64::try_from(secs / 86_400).unwrap_or(0))
    }

    /// Howard Hinnant's `civil_from_days`, valid for any date after 1970.
    fn from_unix_days(days: i64) -> Self {
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z.rem_euclid(146_097);
        let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let day = doy - (153 * mp + 2) / 5 + 1;
        let month = if mp < 10 { mp + 3 } else { mp - 9 };
        let year = yoe + era * 400 + i64::from(month <= 2);
        Self {
            year: u16::try_from(year).unwrap_or(u16::MAX),
            month: u8::try_from(month).unwrap_or(1),
            day: u8::try_from(day).unwrap_or(1),
        }
    }

    /// Writes the date as "24 September 2026".
    pub(crate) fn write_long(self, out: &mut String) {
        use core::fmt::Write as _;
        let month = MONTHS[usize::from(self.month - 1)];
        let _ = write!(out, "{} {month} {}", self.day, self.year);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_unix_days() {
        assert_eq!(Date::from_unix_days(0), Date::new(1970, 1, 1).unwrap());
        assert_eq!(
            Date::from_unix_days(11_016),
            Date::new(2000, 2, 29).unwrap()
        );
        assert_eq!(
            Date::from_unix_days(20_720),
            Date::new(2026, 9, 24).unwrap()
        );
    }

    #[test]
    fn formats_long_dates() {
        let mut s = String::new();
        Date::new(2026, 9, 24).unwrap().write_long(&mut s);
        assert_eq!(s, "24 September 2026");
    }

    #[test]
    fn rejects_impossible_months() {
        assert!(Date::new(2026, 13, 1).is_none());
        assert!(Date::new(2026, 0, 1).is_none());
    }
}

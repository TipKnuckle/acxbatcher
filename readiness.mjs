export async function waitForUploadPage(page, url, timeout = 8000) {
  try {
    await page.waitForFunction(expectedUrl => {
      if (location.href !== expectedUrl) return false;
      return Array.from(document.querySelectorAll('button')).some(button =>
        (button.getAttribute('aria-label') || button.textContent).trim() === 'Add chapter'
        && !button.disabled && button.getClientRects().length > 0);
    }, url, {timeout});
    return true;
  } catch (error) {
    if (error.name === 'TimeoutError') return false;
    throw error;
  }
}

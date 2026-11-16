// FileFit settings. Fill these in after deploying the licence server and creating products.
export const CONFIG = {
  // Licence server (AWS Lambda Function URL), ending with "/". Empty = Pro activation disabled.
  API_BASE: "https://wfimvhejsylu52236zmjggh4mq0abfag.lambda-url.ap-southeast-2.on.aws/",
  // Checkout links (Lemon Squeezy for USD, Razorpay payment page for INR). Empty = button hidden.
  BUY_USD_URL: "",
  BUY_INR_MONTHLY_URL: "https://rzp.io/rzp/B4VACm4",
  BUY_INR_YEARLY_URL: "https://rzp.io/rzp/5fRb33y5",
  PRICE_USD: "$3 / month · $24 / year",
  PRICE_INR: "₹99 / month · ₹799 / year (UPI, cards, netbanking)",
};

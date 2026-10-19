#!/usr/bin/env python3
"""Derive the SES SMTP password from an IAM secret access key.

The secret is read from stdin, never argv, so it stays out of shell history:

    python3 -I infra/ses-smtp-password.py [region] < secret.txt

Same SigV4 transform AWS documents for SES SMTP credentials; the raw secret
will not authenticate. Rotation procedure: infra/README.md.
"""
import base64
import hashlib
import hmac
import sys

DATE = "11111111"
SERVICE = "ses"
MESSAGE = "SendRawEmail"
TERMINAL = "aws4_request"
VERSION = 0x04


def sign(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def smtp_password(secret: str, region: str) -> str:
    signature = sign(("AWS4" + secret).encode("utf-8"), DATE)
    for part in (region, SERVICE, TERMINAL, MESSAGE):
        signature = sign(signature, part)
    return base64.b64encode(bytes([VERSION]) + signature).decode("utf-8")


if __name__ == "__main__":
    region = sys.argv[1] if len(sys.argv) > 1 else "eu-west-1"
    secret = sys.stdin.read().strip()
    if not secret:
        sys.exit("no secret on stdin")
    print(smtp_password(secret, region))

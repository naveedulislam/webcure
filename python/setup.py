from setuptools import setup, find_packages

setup(
    name="webcure",
    version="1.0.0",
    description="Python client for WebCure browser automation",
    packages=find_packages(),
    install_requires=["requests"],
    python_requires=">=3.10",
)

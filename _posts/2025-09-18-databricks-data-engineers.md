---
layout: post
title: "Databricks for Data Engineers: Getting Started"
date: 2025-09-18
categories: [How-To]
tags: [Databricks, Data Engineering, Spark, Analytics]
excerpt: "Get started with Databricks: notebooks, Spark, data pipelines, Delta Lake, and how Databricks enables data engineering at scale."
---

[Databricks](https://www.databricks.com/) is a unified analytics platform built on [Apache Spark](https://spark.apache.org/). Founded by Spark's creators (Matei Zaharia, Ali Ghodsi, and others from UC Berkeley), it's become the standard for big data processing and machine learning at scale.

I moved to Databricks after struggling with self-managed Spark clusters. Maintaining Spark—tuning configs, managing resources, debugging failed jobs—consumed more time than actual data engineering. Databricks handles the infrastructure, letting you focus on transforming data.

The platform combines notebooks for exploration, production-grade job scheduling, Delta Lake for reliable storage, and MLflow for ML workflows. It's opinionated but that opinion is informed by years of Spark expertise.

## Core Components

**Databricks Workspace** - Web-based environment for notebooks, jobs, and clusters.

**Apache Spark** - Distributed processing engine (3.5+ as of 2025). See [Spark documentation](https://spark.apache.org/docs/latest/).

**Delta Lake** - ACID transactions on data lakes. Open source project: [delta-io/delta](https://github.com/delta-io/delta).

**MLflow** - ML lifecycle management. Track experiments, package models, deploy. [MLflow docs](https://mlflow.org/docs/latest/index.html).

**Unity Catalog** - Centralized governance, lineage, and access control.

Read [Databricks architecture](https://docs.databricks.com/en/getting-started/overview.html) for details.

## Notebooks: Interactive Development

Databricks notebooks support Python, SQL, Scala, and R:

### Python Notebook

```python
# Read data from Delta Lake
df = spark.read.format("delta").load("/mnt/data/events")

# Show schema
df.printSchema()

# Quick stats
df.describe().show()

# Transform data
from pyspark.sql.functions import col, count, window

daily_active_users = (df
    .filter(col("event_type") == "login")
    .groupBy(window("timestamp", "1 day"))
    .agg(count("user_id").alias("daily_active_users"))
    .orderBy("window")
)

# Display in notebook
display(daily_active_users)

# Write results
daily_active_users.write.format("delta").mode("overwrite").save("/mnt/data/dau")
```

### SQL Notebook

```sql
-- Create or replace table using Delta Lake
CREATE OR REPLACE TABLE analytics.user_activity
USING DELTA
LOCATION '/mnt/data/user_activity'
AS
SELECT 
    user_id,
    DATE(timestamp) as activity_date,
    COUNT(*) as event_count,
    COUNT(DISTINCT session_id) as session_count
FROM events
WHERE timestamp >= current_date() - INTERVAL 30 DAYS
GROUP BY user_id, DATE(timestamp);

-- Query with visualization
SELECT 
    activity_date,
    COUNT(DISTINCT user_id) as active_users,
    SUM(event_count) as total_events
FROM analytics.user_activity
GROUP BY activity_date
ORDER BY activity_date;
```

Notebooks support inline visualizations—click "Visualization" to create charts.

### Widgets for Parameterization

```python
# Create text widget
dbutils.widgets.text("start_date", "2025-01-01", "Start Date")
dbutils.widgets.dropdown("region", "US", ["US", "EU", "APAC"], "Region")

# Read widget values
start_date = dbutils.widgets.get("start_date")
region = dbutils.widgets.get("region")

# Use in queries
df = spark.read.format("delta").load("/mnt/data/events")
filtered = df.filter(
    (col("date") >= start_date) & 
    (col("region") == region)
)

display(filtered)
```

Widgets make notebooks reusable for different parameters.

## Data Pipelines

### ETL Pipeline

```python
from pyspark.sql import SparkSession

spark = SparkSession.builder.appName("ETL").getOrCreate()

# Extract
raw_data = spark.read.csv("s3://bucket/data.csv")

# Transform
transformed = raw_data.select("id", "name", "age")

# Load
transformed.write.format("delta").save("/mnt/data/processed")
```

## Best Practices

1. **Use notebooks** - Interactive development
2. **Leverage Spark** - Distributed processing
3. **Use Delta Lake** - ACID transactions
4. **Monitor** - Track job performance
5. **Optimize** - Query tuning
6. **Test** - Verify pipelines
7. **Document** - Clear processes
8. **Scale** - Handle large data

## Delta Lake: ACID on Data Lakes

[Delta Lake](https://delta.io/) brings database reliability to data lakes—ACID transactions, schema enforcement, time travel.

### Writing Delta Tables

```python
from pyspark.sql import SparkSession
from delta.tables import DeltaTable

spark = SparkSession.builder.appName("ETL").getOrCreate()

# Write with Delta Lake
df = spark.read.csv("s3://bucket/raw-data.csv", header=True)

(df
    .write
    .format("delta")
    .mode("overwrite")
    .option("overwriteSchema", "true")
    .save("/mnt/data/processed/users")
)

# Append new data
new_data = spark.read.csv("s3://bucket/new-data.csv", header=True)
new_data.write.format("delta").mode("append").save("/mnt/data/processed/users")
```

### Time Travel

Query historical versions:

```python
# Read current version
df_current = spark.read.format("delta").load("/mnt/data/processed/users")

# Read version from 7 days ago
df_old = (spark.read
    .format("delta")
    .option("timestampAsOf", "2025-09-01")
    .load("/mnt/data/processed/users")
)

# Compare
changed_users = df_current.subtract(df_old)
display(changed_users)

# Read specific version number
df_v5 = (spark.read
    .format("delta")
    .option("versionAsOf", 5)
    .load("/mnt/data/processed/users")
)
```

### MERGE (Upserts)

```python
from delta.tables import DeltaTable

# Load Delta table
delta_table = DeltaTable.forPath(spark, "/mnt/data/processed/users")

# Merge updates
delta_table.alias("target").merge(
    source=new_data.alias("source"),
    condition="target.user_id = source.user_id"
).whenMatchedUpdateAll().whenNotMatchedInsertAll().execute()
```

This is how you do CDC (Change Data Capture) efficiently.

### OPTIMIZE and VACUUM

Maintain table performance:

```python
# Optimize: compact small files into larger ones
spark.sql("OPTIMIZE delta.`/mnt/data/processed/users`")

# Z-ordering: colocate related data
spark.sql("OPTIMIZE delta.`/mnt/data/processed/users` ZORDER BY (user_id, created_date)")

# Vacuum: remove old versions (7 day default)
spark.sql("VACUUM delta.`/mnt/data/processed/users` RETAIN 168 HOURS")
```

Run OPTIMIZE weekly, VACUUM monthly. See [Delta Lake performance tuning](https://docs.delta.io/latest/optimizations-oss.html).

## Production ETL Pipeline

```python
from pyspark.sql import SparkSession
from pyspark.sql.functions import col, current_timestamp, sha2, concat_ws
from delta.tables import DeltaTable

class ProductionETL:
    """Production-grade ETL pipeline."""
    
    def __init__(self):
        self.spark = SparkSession.builder.appName("ETL").getOrCreate()
    
    def extract(self, source_path: str):
        """Extract from source."""
        return (self.spark.read
            .format("parquet")
            .load(source_path)
        )
    
    def transform(self, df):
        """Transform data with validation."""
        # Add processing metadata
        df = df.withColumn("processed_at", current_timestamp())
        
        # Data quality checks
        df = df.filter(col("user_id").isNotNull())
        df = df.filter(col("amount") > 0)
        
        # Hash sensitive fields
        df = df.withColumn(
            "email_hash",
            sha2(col("email"), 256)
        )
        
        # Deduplication
        df = df.dropDuplicates(["user_id", "transaction_id"])
        
        return df
    
    def load(self, df, target_path: str):
        """Load to Delta Lake with merge."""
        # Check if table exists
        if DeltaTable.isDeltaTable(self.spark, target_path):
            # Merge into existing table
            delta_table = DeltaTable.forPath(self.spark, target_path)
            
            delta_table.alias("target").merge(
                source=df.alias("source"),
                condition="target.transaction_id = source.transaction_id"
            ).whenMatchedUpdateAll().whenNotMatchedInsertAll().execute()
        else:
            # Create new table
            (df.write
                .format("delta")
                .mode("overwrite")
                .save(target_path)
            )
    
    def run(self, source_path: str, target_path: str):
        """Run complete ETL."""
        try:
            # Extract
            raw_df = self.extract(source_path)
            print(f"Extracted {raw_df.count()} rows")
            
            # Transform
            clean_df = self.transform(raw_df)
            print(f"Cleaned to {clean_df.count()} rows")
            
            # Load
            self.load(clean_df, target_path)
            print(f"Loaded to {target_path}")
            
            # Optimize after load
            self.spark.sql(f"OPTIMIZE delta.`{target_path}`")
            
        except Exception as e:
            print(f"ETL failed: {e}")
            raise

# Usage
etl = ProductionETL()
etl.run(
    source_path="s3://bucket/raw/transactions/",
    target_path="/mnt/data/processed/transactions"
)
```

## Best Practices from Production

1. **Use Delta Lake always** - ACID guarantees are worth it
2. **Partition large tables** - By date or high-cardinality keys
3. **Z-order frequently queried columns** - Colocates data
4. **Set retention policies** - Balance time travel vs storage costs
5. **Monitor cluster metrics** - CPU, memory, I/O utilization
6. **Right-size clusters** - Match to workload (don't over-provision)
7. **Use auto-termination** - Clusters shutdown after idle time
8. **Enable Photon** - Vectorized execution engine (2-5x faster)
9. **Cache frequently accessed data** - `df.cache()` for reuse
10. **Test with small samples** - `.limit(1000)` for development

## Conclusion

Databricks simplifies data engineering by handling Spark cluster management, providing excellent notebook UX, and offering Delta Lake for reliable storage. The managed platform lets you focus on transforming data rather than managing infrastructure.

The combination of Spark's distributed processing, Delta Lake's ACID guarantees, and notebook-based development creates a productive environment for data teams. ETL pipelines that took days to build on self-managed Spark can be prototyped in hours on Databricks.

Cost management is crucial—clusters can get expensive. Use autoscaling, right-size instances, and terminate idle clusters. The productivity gains typically justify the costs for teams processing terabytes of data.

**Further Resources:**
- [Databricks Documentation](https://docs.databricks.com/) - Comprehensive guides
- [Apache Spark Docs](https://spark.apache.org/docs/latest/) - Core engine
- [Delta Lake](https://delta.io/) - Open format and engine
- [MLflow](https://mlflow.org/) - ML lifecycle management
- [Databricks Academy](https://www.databricks.com/learn/training) - Free courses
- [Delta Lake GitHub](https://github.com/delta-io/delta) - Open source repo
- [Unity Catalog](https://docs.databricks.com/en/data-governance/unity-catalog/index.html) - Data governance

---

*Databricks for data engineers from September 2025 — updated with production guidance.*

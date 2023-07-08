import * as cdk from "aws-cdk-lib";
import { Artifact, Pipeline } from "aws-cdk-lib/aws-codepipeline";
import {
  CodeBuildAction,
  CodeDeployServerDeployAction,
  GitHubSourceAction,
} from "aws-cdk-lib/aws-codepipeline-actions";
import {
  AmazonLinuxCpuType,
  AmazonLinuxGeneration,
  AmazonLinuxImage,
  Instance,
  InstanceClass,
  InstanceSize,
  InstanceType,
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import { ManagedPolicy, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { readFileSync } from "fs";
import { SecretValue } from "aws-cdk-lib";
import { LinuxBuildImage, PipelineProject } from "aws-cdk-lib/aws-codebuild";
import {
  InstanceTagSet,
  ServerApplication,
  ServerDeploymentGroup,
} from "aws-cdk-lib/aws-codedeploy";

export class Ec2CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    /* The code is creating an IAM role (`ec2Role`) for an EC2 instance. */
    const ec2Role = new Role(this, "ec2Role", {
      assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
    });

    ec2Role.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")
    );

    ec2Role.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName(
        "service-role/AmazonEC2RoleforAWSCodeDeploy"
      )
    );

    /* The code is creating a VPC (Virtual Private Cloud) with the ID "main-vpc". */
    const vpc = new Vpc(this, "main-vpc", {
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "pub001",
          subnetType: SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: "pub002",
          subnetType: SubnetType.PUBLIC,
        },
      ],
    });

    /* The code is creating a security group (`ec2Sg`) for an EC2 instance. */
    const ec2Sg = new SecurityGroup(this, "ec2-sg", {
      vpc,
      description: "Allow HTTP traffic to ec2 server",
      allowAllOutbound: true,
    });
    ec2Sg.addEgressRule(Peer.anyIpv4(), Port.tcp(80));

    const ami = new AmazonLinuxImage({
      generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
      cpuType: AmazonLinuxCpuType.X86_64,
    });

    /* The code is creating an EC2 instance named "ec2-server" within the specified VPC. */
    const ec2Server = new Instance(this, "ec2-server", {
      vpc,
      instanceType: InstanceType.of(InstanceClass.T2, InstanceSize.MICRO),
      machineImage: ami,
      role: ec2Role,
      securityGroup: ec2Sg,
    });

    const ec2UserData = readFileSync(
      "../assets/configure_amz_linux_sample_app.sh",
      "utf-8"
    );
    ec2Server.addUserData(ec2UserData);
    cdk.Tags.of(ec2Server).add("app-name", "web-app");
    cdk.Tags.of(ec2Server).add("stage", "dev");

    try {
      new cdk.CfnOutput(this, "IP addr", {
        value: ec2Server.instancePublicIp,
      });
    } catch (error) {}

    /* The code is creating an AWS CodePipeline object named `codePipeline` with the name
    "python-web-app". The `Pipeline` class is imported from the `aws-cdk-lib/aws-codepipeline`
    module. */
    const codePipeline = new Pipeline(this, "python-web-app", {
      pipelineName: "python-web-app",
      crossAccountKeys: false,
    });
    const sourceStage = codePipeline.addStage({ stageName: "Source" });
    const buildStage = codePipeline.addStage({ stageName: "Build" });
    const deployStage = codePipeline.addStage({ stageName: "Deploy" });

    const sourceOutput = new Artifact();
    const ghSourceAction = new GitHubSourceAction({
      actionName: "GitHubSource",
      oauthToken: SecretValue.secretsManager("github-oauth-token"),
      owner: "pgandla",
      repo: "python-web-app",
      branch: "main",
      output: sourceOutput,
    });
    sourceStage.addAction(ghSourceAction);

    const pythonTestPrj = new PipelineProject(this, "pythonTestProject", {
      environment: {
        buildImage: LinuxBuildImage.AMAZON_LINUX_2_3,
      },
    });

    const pythonTestOutput = new Artifact();
    const pythonTestAction = new CodeBuildAction({
      actionName: "TestPythonApplication",
      project: pythonTestPrj,
      input: sourceOutput,
      outputs: [pythonTestOutput],
    });
    buildStage.addAction(pythonTestAction);

    const pythonDeployApp = new ServerApplication(this, "pythonDeployApp", {
      applicationName: "pythonWebApp",
    });

    const pythonServerDeployGrp = new ServerDeploymentGroup(
      this,
      "pythonAppDeployGrp",
      {
        application: pythonDeployApp,
        deploymentGroupName: "pythonAppDeployGrp",
        installAgent: true,
        ec2InstanceTags: new InstanceTagSet({
          "app-name": ["web-app"],
          stage: ["dev"],
        }),
      }
    );
    const pythonDeployAction = new CodeDeployServerDeployAction({
      actionName: "PythonAppDeployment",
      input: sourceOutput,
      deploymentGroup: pythonServerDeployGrp,
    });
    deployStage.addAction(pythonDeployAction);
  }
}
